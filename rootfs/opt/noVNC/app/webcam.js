import * as Log from '../core/util/logging.js';

const FPS = 30;
const ENCODER_CONFIG = {
    codec: 'avc1.42E01F', width: 1280, height: 720, framerate: FPS,
    bitrate: 1000000, latencyMode: 'realtime', avc: { format: 'annexb' },
};
const HIGH_WATER_BYTES = 512 * 1024;
const MAX_BUFFERED_BYTES = 2 * 1024 * 1024;
const SOCKET_CHUNK_BYTES = 16000;
const CONGESTION_TIMEOUT_MS = 2000;
const SETUP_TIMEOUT_MS = 10000;
const CAPTURE_TIMEOUT_MS = 30000;
const CLOSE_TIMEOUT_MS = 1500;

function withTimeout(promise, duration, operation) {
    let timer;
    return Promise.race([
        promise,
        new Promise((_, reject) => {
            timer = setTimeout(() => {
                const error = new Error(`${operation} timed out`);
                error.name = 'TimeoutError';
                reject(error);
            }, duration);
        }),
    ]).finally(() => clearTimeout(timer));
}

function stopTracks(stream) {
    stream?.getTracks().forEach(track => track.stop());
}

function webcamUnavailableReason(media) {
    if (!window.isSecureContext) return 'Webcam access requires HTTPS (or localhost).';
    const policy = document.permissionsPolicy || document.featurePolicy;
    if (policy?.allowsFeature?.('camera') === false) {
        return 'Camera access is blocked for this page. Open the desktop directly, or allow camera access for the embedded page.';
    }
    if (!media?.getUserMedia || !window.VideoEncoder || !window.VideoFrame) {
        return 'This browser cannot encode webcam video with WebCodecs H.264.';
    }
    return '';
}

function captureConstraints(deviceId) {
    const video = {
        width: { exact: 1280 }, height: { exact: 720 }, frameRate: { ideal: FPS, max: FPS },
    };
    if (deviceId) video.deviceId = { exact: deviceId };
    return { video, audio: false };
}

export default class Webcam {
    constructor(controls, url, reportError) {
        for (const key of ['button', 'select', 'label', 'icon', 'status']) {
            if (!controls[key]) throw new TypeError(`Missing webcam control: ${key}`);
            this[key] = controls[key];
        }

        this.url = url;
        this.reportError = reportError;
        // Session identity invalidates callbacks from cancelled permissions and recordings.
        this.session = null;
        this.connected = false;
        this.devices = [];
        this.selectedId = '';
        this.devicesRequest = 0;
        this.scanning = false;
        // Device switches wait for the previous socket to finish closing.
        this.transportClosed = Promise.resolve();
        this.media = navigator.mediaDevices;
        this.unavailable = webcamUnavailableReason(this.media);

        this.bindEvents();
        this.render();
        this.setStatus(this.unavailable || 'Connect to the desktop to use your webcam.');
    }

    bindEvents() {
        this.button.addEventListener('click', () => {
            if (this.session) this.stop();
            else void this.start();
        });
        this.select.addEventListener('change', () => {
            this.selectedId = this.select.value;
            if (this.session) void this.switchWebcam();
            else this.setStatus('Webcam off. Enable to use the selected webcam.');
        });

        const refreshOnOpen = () => this.refreshDevicesOnOpen();
        this.select.addEventListener('focus', refreshOnOpen);
        this.select.addEventListener('pointerdown', refreshOnOpen);
        this.select.addEventListener('keydown', event => {
            if (['ArrowDown', 'ArrowUp', ' ', 'Enter'].includes(event.key)) refreshOnOpen();
        });
        this.media?.addEventListener?.('devicechange', () => {
            void this.refreshDevices({ deviceChange: true });
        });
        window.addEventListener('pagehide', () => this.stop('Webcam off'));
    }

    refreshDevicesOnOpen() {
        if (this.select.disabled || this.scanning) return;
        void this.refreshDevices({ manual: true });
    }

    setStatus(message, { error = false, severity = error ? 'error' : 'info' } = {}) {
        this.statusError = error;
        this.status.textContent = error ? message : '';
        this.status.classList.toggle('noVNC_hidden', !error);
        if (severity === 'error') Log.Error(message);
        else if (severity === 'warn') Log.Warn(message);
        else Log.Info(message);
    }

    render() {
        const active = Boolean(this.session?.sending);
        const pending = Boolean(this.session && !active);
        const disabled = !this.connected;

        this.button.disabled = disabled;
        this.label.textContent = active ? 'Disable webcam'
            : pending ? 'Cancel webcam' : 'Enable webcam';
        this.button.setAttribute('aria-pressed', String(active));
        this.button.title = active
            ? 'Stop sending your webcam to the container'
            : pending ? 'Cancel webcam access'
                : 'Send the selected webcam to the container';
        this.icon.classList.toggle('fa-video', active);
        this.icon.classList.toggle('fa-video-slash', !active);

        // Changing cameras starts a new encoder and requires a new socket.
        this.select.disabled = disabled || pending;
        this.renderDevices();
    }

    setConnected(connected) {
        this.connected = connected;
        if (!connected) this.stop('Connect to the desktop to use your webcam.');
        else if (!this.unavailable) void this.refreshDevices();
        if (this.unavailable) this.setStatus(this.unavailable, { error: true });
        this.render();
    }

    deviceOptions() {
        const defaultName = (!this.selectedId && this.session?.deviceLabel) || this.defaultLabel;
        const options = [
            ['', defaultName ? `Default (${defaultName})` : 'Default'],
            ...this.devices.map((device, index) => [
                device.deviceId, device.label || `Webcam ${index + 1}`,
            ]),
        ];
        if (this.selectedId && !options.some(([id]) => id === this.selectedId)) {
            options.push([this.selectedId, this.session?.deviceLabel || 'Selected webcam']);
        }
        return options;
    }

    renderDevices() {
        const options = this.deviceOptions();
        const signature = JSON.stringify(options);
        // Preserve the open native selector if its options have not changed.
        if (this.renderedDevices !== signature) {
            this.renderedDevices = signature;
            this.select.replaceChildren();
            for (const [value, label] of options) {
                const option = document.createElement('option');
                option.value = value;
                option.textContent = label;
                option.title = label;
                this.select.appendChild(option);
            }
        }
        if (this.select.value !== this.selectedId) this.select.value = this.selectedId;
        this.select.title = this.select.selectedOptions[0]?.textContent || 'Webcam source';
    }

    updateDeviceList(allDevices) {
        const inputs = allDevices.filter(device =>
            device.kind === 'videoinput' && device.deviceId);

        // Chromium exposes "default" and "communications" as aliases.
        const physical = inputs.filter(device =>
            !['default', 'communications'].includes(device.deviceId));
        const defaultAlias = inputs.find(device => device.deviceId === 'default');
        const defaultDevice = physical.find(device =>
            defaultAlias?.groupId && device.groupId === defaultAlias.groupId)
            || defaultAlias || physical[0];

        this.defaultLabel = defaultDevice?.label?.replace(/^default\s*[-:]\s*/i, '')
            || this.defaultLabel;
        this.devices = physical.filter((device, index) =>
            physical.findIndex(other => other.deviceId === device.deviceId) === index);

        return Boolean(this.selectedId &&
            !this.devices.some(device => device.deviceId === this.selectedId));
    }

    handleMissingDevice(missing, deviceChange) {
        if (deviceChange && missing && this.session?.stream) {
            this.fail(this.session, 'The selected webcam was disconnected or access was revoked. Reconnect a webcam and enable it again.');
        } else if (deviceChange && missing && !this.session) {
            this.setStatus('The selected webcam is no longer available. Connect a webcam and enable it again.', { severity: 'warn' });
        }
        if (missing && !this.session) this.selectedId = '';
    }

    reportDeviceRefresh(manual, deviceChange, missing) {
        if (!this.session && this.connected && !(deviceChange && missing) && (manual || !this.statusError)) {
            this.setStatus(!this.devices.length
                ? 'No webcams are listed. Connect a webcam and enable access.'
                : 'Webcam off. Enable it to select a source.');
        }
        if (manual && this.session) this.setStatus('Webcam list refreshed.');
    }

    async refreshDevices({ manual = false, deviceChange = false } = {}) {
        if (this.unavailable) return;
        if (!this.media.enumerateDevices) {
            if (!this.session && !this.statusError) {
                this.setStatus('Your browser cannot list webcams. Enable to use the default webcam.');
            }
            return;
        }
        const request = ++this.devicesRequest;
        this.scanning = true;
        this.render();
        try {
            const devices = await this.media.enumerateDevices();
            if (request !== this.devicesRequest) return;
            const missing = this.updateDeviceList(devices);
            this.handleMissingDevice(missing, deviceChange);
            this.renderDevices();
            this.reportDeviceRefresh(manual, deviceChange, missing);
        } catch (error) {
            if (request === this.devicesRequest && this.connected) {
                Log.Warn(`Webcam device enumeration failed: ${error}`);
                if (manual) {
                    this.setStatus('Could not update the webcam list. Try reopening the source selector.', { error: true, severity: 'warn' });
                }
            }
        } finally {
            if (request === this.devicesRequest) {
                this.scanning = false;
                this.render();
            }
        }
    }

    static captureError(error) {
        switch (error?.name) {
            case 'NotFoundError':
            case 'DevicesNotFoundError':
                return 'No webcam was recognized. Connect a webcam and try again.';
            case 'NotAllowedError':
            case 'PermissionDeniedError':
                return 'Webcam access was blocked. Allow webcam access in your browser\'s site settings, then enable it again.';
            case 'OverconstrainedError':
            case 'ConstraintNotSatisfiedError':
                return 'The selected camera cannot provide 1280x720 video, or is no longer available. Select another camera and try again.';
            case 'NotReadableError':
            case 'TrackStartError':
            case 'AbortError':
                return 'The webcam could not be opened. Check that it is connected and not being used by another application, then try again.';
            case 'TimeoutError':
                return 'Webcam access timed out. Respond to the browser permission prompt and retry.';
            case 'NotSupportedError':
                return 'This browser could not start H.264 webcam encoding. Try a browser supporting WebCodecs H.264.';
            case 'SecurityError':
                return 'Webcam access is disabled by your browser or its security settings. Allow access for this site and try again.';
            default:
                return 'Could not start the webcam. Check that a webcam is connected and allowed in your browser, then try again.';
        }
    }

    isCurrentSession(session) {
        return this.session === session;
    }

    releaseInput(session) {
        if (session.stream) {
            stopTracks(session.stream);
            session.stream = null;
        }
    }

    watchTrack(session, track) {
        track.addEventListener('ended', () => {
            if (this.isCurrentSession(session)) {
                this.fail(session, 'Webcam access ended or the device was disconnected. Reconnect a webcam and enable it again.');
            }
        });
        track.addEventListener('mute', () => {
            if (this.isCurrentSession(session)) {
                this.setStatus('The webcam is temporarily muted or unavailable. Check the device and browser settings.', { severity: 'warn' });
            }
        });
        track.addEventListener('unmute', () => {
            if (this.isCurrentSession(session) && session.sending) this.showSending(session);
        });
    }

    async acquire(session, deviceId) {
        const stream = await this.media.getUserMedia(captureConstraints(deviceId));
        if (!this.isCurrentSession(session)) {
            stopTracks(stream);
            return null;
        }
        session.stream = stream;
        const track = stream.getVideoTracks()[0];
        if (!track || track.readyState === 'ended') throw new DOMException('', 'NotFoundError');
        session.deviceLabel = track.label || 'Selected webcam';
        // Selecting "Default" must not pin the resolved physical device.
        if (!deviceId) this.defaultLabel = track.label || this.defaultLabel;
        this.watchTrack(session, track);
        // Permission makes labels available; enumeration does not prompt for capture.
        void this.refreshDevices();
        return stream;
    }

    showSending(session) {
        const muted = session.stream?.getVideoTracks()[0]?.muted;
        this.setStatus(muted
            ? 'The webcam is temporarily muted or unavailable. Check the device and browser settings.'
            : `Sending: ${session.deviceLabel}`, { severity: muted ? 'warn' : 'info' });
    }

    createEncoder(session) {
        return new VideoEncoder({
            output: chunk => this.send(session, chunk),
            error: error => this.fail(session, 'Webcam encoding failed. Enable the webcam again to retry.', error),
        });
    }

    async startEncoding(session) {
        if (!this.isCurrentSession(session)) return;
        clearTimeout(session.connectionTimer);
        try {
            const video = document.createElement('video');
            session.video = video;
            video.muted = true;
            video.playsInline = true;
            video.srcObject = session.stream;
            await withTimeout(video.play(), SETUP_TIMEOUT_MS, 'Camera video startup');
            if (!this.isCurrentSession(session)) return;
            session.sending = true;
            session.nextCapture = null;
            session.nextKeyframe = 0;
            this.render();
            this.showSending(session);
            const capture = now => {
                if (!this.isCurrentSession(session)) return;
                try {
                    const busy = session.encoder.encodeQueueSize >= 2 || session.socket.bufferedAmount > HIGH_WATER_BYTES;
                    if (busy) {
                        session.congestionSince ??= now;
                        if (now - session.congestionSince >= CONGESTION_TIMEOUT_MS) {
                            this.fail(session, 'Webcam stopped: the encoder or connection cannot keep up with the video stream.');
                            return;
                        }
                    } else {
                        session.congestionSince = null;
                        session.nextCapture ??= now;
                        if (now >= session.nextCapture) {
                            const frame = new VideoFrame(video, { timestamp: Math.round(now * 1000) });
                            try {
                                const keyFrame = now >= session.nextKeyframe;
                                session.encoder.encode(frame, { keyFrame });
                                if (keyFrame) session.nextKeyframe = now + 2000;
                                session.nextCapture += 1000 / FPS;
                                if (session.nextCapture < now) session.nextCapture = now + 1000 / FPS;
                            } finally {
                                frame.close();
                            }
                        }
                    }
                    schedule();
                } catch (error) {
                    this.fail(session, 'Could not capture or encode the webcam frame.', error);
                }
            };
            const schedule = () => {
                if (video.requestVideoFrameCallback) session.frameCallback = video.requestVideoFrameCallback(capture);
                else session.frameTimer = setTimeout(() => capture(performance.now()), 1000 / FPS);
            };
            schedule();
        } catch (error) {
            this.fail(session, 'Webcam video could not start.', error);
        }
    }

    connect(session) {
        const socket = new WebSocket(this.url(), ['binary']);
        session.socket = socket;
        socket.onopen = () => void this.startEncoding(session);
        socket.onclose = event => this.fail(session,
            session.sending
                ? 'The webcam stream disconnected. Enable it again to reconnect.'
                : 'Could not open the webcam stream. Another desktop session may be using it. Try again.',
            `close code=${event.code}, clean=${event.wasClean}`);
        socket.onerror = () => this.fail(session,
            'Could not connect the webcam stream. Check your connection and sign in again if needed.');

        session.connectionTimer = setTimeout(() => this.fail(session,
            'The webcam connection timed out. Check your connection and try again.'),
            SETUP_TIMEOUT_MS);
        this.setStatus('Connecting the selected webcam…');
    }

    async prepareSession(session) {
        // Check the service/device before prompting for or opening a local camera.
        const response = await withTimeout(fetch('./webcam-status.json', { cache: 'no-store' }),
            SETUP_TIMEOUT_MS, 'Webcam service check');
        if (!this.isCurrentSession(session)) return;
        if (!response.ok) throw new Error('Webcam service is unavailable. Check WEB_CAM and CAM_DEV.');
        const status = await withTimeout(response.json(), SETUP_TIMEOUT_MS, 'Webcam service status');
        if (!this.isCurrentSession(session)) return;
        if (!status.ready) throw new Error(status.error || 'Webcam service is not ready. Check CAM_DEV.');
        if (this.unavailable) throw new Error(this.unavailable);
        const supported = await withTimeout(VideoEncoder.isConfigSupported(ENCODER_CONFIG),
            SETUP_TIMEOUT_MS, 'H.264 capability check');
        if (!this.isCurrentSession(session)) return;
        if (!supported.supported) throw new Error('This browser cannot encode the required Baseline H.264 Annex B webcam stream.');
        const stream = await withTimeout(this.acquire(session, this.selectedId), CAPTURE_TIMEOUT_MS, 'Camera access');
        if (!stream || !this.isCurrentSession(session)) return;
        await this.transportClosed;
        if (!this.isCurrentSession(session)) return;
        session.encoder = this.createEncoder(session);
        session.encoder.configure(ENCODER_CONFIG);
        this.connect(session);
    }

    async start() {
        if (this.session || !this.connected) return;

        const session = { sending: false, chunks: 0, bytes: 0 };
        this.session = session;
        this.render();
        this.setStatus('Waiting for webcam permission. Allow the selected webcam, or cancel.');

        try {
            await this.prepareSession(session);
        } catch (error) {
            this.fail(session, error?.name === 'Error' ? error.message : Webcam.captureError(error), error);
        }
    }

    send(session, chunk) {
        if (!this.isCurrentSession(session) || session.socket?.readyState !== WebSocket.OPEN) return;
        if (chunk.byteLength === 0 || chunk.byteLength > MAX_BUFFERED_BYTES ||
            session.socket.bufferedAmount + chunk.byteLength + 4 > MAX_BUFFERED_BYTES) {
            // Terminate rather than discard an encoded delta frame and break references.
            this.fail(session, 'Webcam stopped: your connection cannot keep up with the video stream.');
            return;
        }
        try {
            const packet = new Uint8Array(4 + chunk.byteLength);
            new DataView(packet.buffer).setUint32(0, chunk.byteLength, false);
            chunk.copyTo(packet.subarray(4));
            // NGINX websockify rejects WebSocket frames larger than 65535 bytes.
            for (let offset = 0; offset < packet.byteLength; offset += SOCKET_CHUNK_BYTES) {
                session.socket.send(packet.buffer.slice(offset, offset + SOCKET_CHUNK_BYTES));
            }
            session.chunks++;
            session.bytes += packet.byteLength;
        } catch (error) {
            this.fail(session, 'The webcam stream could not send video. Enable it again to retry.', error);
        }
    }

    switchWebcam() {
        if (!this.session) return;
        // A new encoder must start with a keyframe and a fresh decoder session.
        this.stop('Switching webcams…');
        return this.start();
    }

    fail(session, message, cause = null) {
        if (!this.isCurrentSession(session)) return;
        Log.Error(`Webcam failure: ${message}${cause ? `; cause=${cause}` : ''}`);
        this.stop(message, { error: true });
        try {
            this.reportError?.(message);
        } catch (error) {
            Log.Error(`Webcam error reporter failed: ${error}`);
        }
        void this.refreshDevices();
    }

    closeTransport(socket) {
        if (socket.readyState === WebSocket.CLOSED) return Promise.resolve();

        return new Promise(resolve => {
            const finish = () => {
                clearTimeout(timer);
                socket.removeEventListener('close', finish);
                resolve();
            };
            const timer = setTimeout(finish, CLOSE_TIMEOUT_MS);
            socket.addEventListener('close', finish, { once: true });

            try {
                socket.close();
            } catch (error) {
                Log.Warn(`Webcam close failed: ${error}`);
                finish();
            }
        });
    }

    async closeSession(session) {
        clearTimeout(session.connectionTimer);
        clearTimeout(session.frameTimer);
        if (session.frameCallback !== undefined) session.video?.cancelVideoFrameCallback?.(session.frameCallback);
        if (session.socket) {
            session.socket.onopen = null;
            session.socket.onclose = null;
            session.socket.onerror = null;
        }
        this.releaseInput(session);
        if (session.video) {
            session.video.pause();
            session.video.srcObject = null;
        }
        if (session.encoder && session.encoder.state !== 'closed') session.encoder.close();
        Log.Info(`Webcam stopped: chunks=${session.chunks}, bytes=${session.bytes}`);
        if (session.socket) await this.closeTransport(session.socket);
    }

    stop(message = 'Webcam off', { error = false } = {}) {
        const session = this.session;
        this.session = null; // Pending permissions and callbacks become obsolete immediately.
        if (session) {
            const closing = this.closeSession(session);
            // Preserve earlier cleanup even if this session was cancelled before connecting.
            this.transportClosed = Promise.all([this.transportClosed, closing]).then(() => { });
        }
        this.render();
        this.setStatus(message, { error });
        return this.transportClosed;
    }
}
