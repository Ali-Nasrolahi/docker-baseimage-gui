import * as Log from '../core/util/logging.js';

const FRAME_BYTES = 1920;
const MAX_BUFFERED_BYTES = FRAME_BYTES * 5;
const FRAME_INTERVAL_MS = 20;
const MAX_FRAME_AGE_SECONDS = 0.15;
const SETUP_TIMEOUT_MS = 10000;
const CAPTURE_TIMEOUT_MS = 30000;
const CLOSE_TIMEOUT_MS = 1500;
const DEVICE_REFRESH_INTERVAL_MS = 2000;
const WORKLET_URL = new URL('./microphone-worklet.js', import.meta.url);

function withTimeout(promise, duration, operation) {
    let timer;
    return Promise.race([
        promise,
        new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error(`${operation} timed out`)), duration);
        }),
    ]).finally(() => clearTimeout(timer));
}

function stopTracks(stream) {
    stream?.getTracks().forEach(track => track.stop());
}

function microphoneUnavailableReason(media, AudioContextClass) {
    if (!window.isSecureContext) {
        return 'Microphone access requires HTTPS (or localhost).';
    }
    const policy = document.permissionsPolicy || document.featurePolicy;
    if (policy?.allowsFeature?.('microphone') === false) {
        return 'Microphone access is blocked for this page. Open the desktop directly in a browser tab, or allow microphone access for the embedded page.';
    }
    if (!media?.getUserMedia || !AudioContextClass || !window.AudioWorkletNode) {
        return 'This browser does not support microphone redirection. Try a current version of Firefox, Chrome, or Edge.';
    }
    return '';
}

function captureConstraints(deviceId) {
    const audio = {
        channelCount: { ideal: 1 },
        sampleRate: { ideal: 48000 },
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
    };
    if (deviceId) audio.deviceId = { exact: deviceId };
    return { audio };
}

export default class Microphone {
    constructor(controls, url, reportError) {
        for (const key of ['button', 'select', 'label', 'icon', 'status']) {
            if (!controls[key]) throw new TypeError(`Missing microphone control: ${key}`);
            this[key] = controls[key];
        }

        this.url = url;
        this.reportError = reportError;
        this.session = null;
        this.connected = false;
        this.devices = [];
        this.selectedId = '';
        this.devicesRequest = 0;
        this.scanning = false;
        this.lastDeviceRefresh = 0;
        this.transportClosed = Promise.resolve();
        this.media = navigator.mediaDevices;
        this.Context = window.AudioContext || window.webkitAudioContext;
        this.unavailable = microphoneUnavailableReason(this.media, this.Context);

        this.bindEvents();
        this.renderDevices();
        this.render();
        this.setStatus(this.unavailable || 'Connect to the desktop to use your microphone.');
    }

    bindEvents() {
        this.button.addEventListener('click', () => {
            if (this.session) this.stop();
            else void this.start();
        });
        this.select.addEventListener('change', () => {
            this.selectedId = this.select.value;
            if (this.session) void this.switchMicrophone();
            else this.setStatus('Microphone off. Enable to use the selected microphone.');
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
        window.addEventListener('pagehide', () => this.stop());
    }

    refreshDevicesOnOpen() {
        if (this.select.disabled || this.scanning) return;
        if (Date.now() - this.lastDeviceRefresh <= DEVICE_REFRESH_INTERVAL_MS) return;
        void this.refreshDevices({ manual: true });
    }

    setStatus(message, error = false, severity = error ? 'error' : 'info') {
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
        this.button.disabled = !this.connected || Boolean(this.unavailable);
        this.label.textContent = active ? 'Disable microphone' : pending ? 'Cancel microphone' : 'Enable microphone';
        this.button.setAttribute('aria-pressed', active ? 'true' : 'false');
        this.button.title = active
            ? 'Stop sending your microphone to the container'
            : pending ? 'Cancel microphone access' : 'Send the selected microphone to the container';
        this.icon.classList.toggle('fa-microphone', active);
        this.icon.classList.toggle('fa-microphone-slash', !active);

        // Source changes are safe after the socket opens: silence can fill the gap.
        const starting = this.session && this.session.socket?.readyState !== WebSocket.OPEN;
        this.select.disabled = !this.connected || Boolean(this.unavailable) || Boolean(starting);
        this.renderDevices();
    }

    setConnected(connected) {
        this.connected = connected;
        if (!connected) this.stop('Connect to the desktop to use your microphone.');
        else if (!this.unavailable) void this.refreshDevices();
        if (this.unavailable) this.setStatus(this.unavailable, true);
        this.render();
    }

    deviceOptions() {
        const defaultName = (!this.selectedId && this.session?.deviceLabel) || this.defaultLabel;
        const options = [
            ['', defaultName ? `Default (${defaultName})` : 'Default'],
            ...this.devices.map((device, index) => [
                device.deviceId, device.label || `Microphone ${index + 1}`,
            ]),
        ];
        if (this.selectedId && !options.some(([id]) => id === this.selectedId)) {
            options.push([this.selectedId, this.session?.deviceLabel || 'Selected microphone']);
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
        this.select.title = this.select.selectedOptions[0]?.textContent || 'Microphone source';
    }

    updateDeviceList(allDevices) {
        const inputs = allDevices.filter(device => device.kind === 'audioinput' && device.deviceId);
        // Chromium includes aliases for physical microphones.
        const physical = inputs.filter(device => !['default', 'communications'].includes(device.deviceId));
        const defaultAlias = inputs.find(device => device.deviceId === 'default');
        const defaultDevice = physical.find(device => defaultAlias?.groupId && device.groupId === defaultAlias.groupId)
            || defaultAlias || physical[0];
        this.defaultLabel = defaultDevice?.label?.replace(/^default\s*[-:]\s*/i, '') || this.defaultLabel;
        this.devices = physical.filter((device, index) =>
            physical.findIndex(other => other.deviceId === device.deviceId) === index);
        return Boolean(this.selectedId && !this.devices.some(device => device.deviceId === this.selectedId));
    }

    handleMissingDevice(missing, deviceChange) {
        if (deviceChange && missing && this.session?.stream) {
            this.fail(this.session, 'The selected microphone was disconnected or access was revoked. Reconnect a microphone and enable it again.');
        } else if (deviceChange && missing && !this.session) {
            this.setStatus('The selected microphone is no longer available. Connect a microphone and enable it again.', false, 'warn');
        }
        if (missing && !this.session) this.selectedId = '';
    }

    reportDeviceRefresh(manual, deviceChange, missing) {
        if (!this.session && this.connected && !(deviceChange && missing) && (manual || !this.statusError)) {
            this.setStatus(!this.devices.length
                ? 'No microphones are listed. Connect a microphone and enable access.'
                : 'Microphone off. Enable it to select a source.');
        }
        if (manual && this.session) this.setStatus('Microphone list refreshed.');
    }

    async refreshDevices({ manual = false, deviceChange = false } = {}) {
        if (this.unavailable) return;
        if (!this.media.enumerateDevices) {
            if (!this.session) this.setStatus('Your browser cannot list microphones. Enable to use the default microphone.');
            return;
        }
        const request = ++this.devicesRequest;
        this.scanning = true;
        this.render();
        try {
            const devices = await this.media.enumerateDevices();
            if (request !== this.devicesRequest) return;
            this.lastDeviceRefresh = Date.now();
            const missing = this.updateDeviceList(devices);
            this.handleMissingDevice(missing, deviceChange);
            this.renderDevices();
            this.reportDeviceRefresh(manual, deviceChange, missing);
        } catch (error) {
            if (request === this.devicesRequest && this.connected) {
                Log.Warn(`Microphone device enumeration failed: ${error}`);
                if (manual) {
                    this.setStatus('Could not update the microphone list. Try reopening the source selector.', true, 'warn');
                }
            }
        } finally {
            if (request === this.devicesRequest) {
                this.scanning = false;
                // Preserve the original behavior: permit another refresh on selector open.
                this.lastDeviceRefresh = 0;
                this.render();
            }
        }
    }

    static captureError(error) {
        switch (error?.name) {
            case 'NotFoundError':
            case 'DevicesNotFoundError':
                return 'No microphone was recognized. Connect a microphone and try again.';
            case 'NotAllowedError':
            case 'PermissionDeniedError':
                return 'Microphone access was blocked. Allow microphone access in your browser\'s site settings, then enable it again.';
            case 'OverconstrainedError':
            case 'ConstraintNotSatisfiedError':
                return 'The selected microphone is no longer available. Connect an available microphone and enable it again.';
            case 'NotReadableError':
            case 'TrackStartError':
            case 'AbortError':
                return 'The microphone could not be opened. Check that it is connected and not being used by another application, then try again.';
            case 'SecurityError':
                return 'Microphone access is disabled by your browser or its security settings. Allow access for this site and try again.';
            default:
                return 'Could not start the microphone. Check that a microphone is connected and allowed in your browser, then try again.';
        }
    }

    current(session, captureId = session.captureId) {
        return this.session === session && session.captureId === captureId;
    }

    releaseInput(session) {
        if (session.source) {
            try { session.source.disconnect(); } catch (_) { /* Already disconnected. */ }
            session.source = null;
        }
        if (session.stream) {
            stopTracks(session.stream);
            session.stream = null;
        }
    }

    watchTrack(session, track, captureId) {
        track.addEventListener('ended', () => {
            if (this.current(session, captureId)) {
                this.fail(session, 'Microphone access ended or the device was disconnected. Reconnect a microphone and enable it again.');
            }
        });
        track.addEventListener('mute', () => {
            if (this.current(session, captureId)) {
                this.setStatus('The microphone is temporarily muted or unavailable. Check the device and browser settings.', false, 'warn');
            }
        });
        track.addEventListener('unmute', () => {
            if (this.current(session, captureId) && session.sending) this.showSending(session);
        });
    }

    async acquire(session, deviceId, captureId) {
        const stream = await this.media.getUserMedia(captureConstraints(deviceId));
        if (!this.current(session, captureId)) {
            stopTracks(stream);
            return null;
        }
        session.stream = stream;
        const track = stream.getAudioTracks()[0];
        if (!track || track.readyState === 'ended') throw new DOMException('', 'NotFoundError');
        session.deviceLabel = track.label || 'Selected microphone';
        // Selecting "Default" must not pin the resolved physical device.
        if (!deviceId) this.defaultLabel = track.label || this.defaultLabel;
        this.watchTrack(session, track, captureId);
        // Permission makes labels available; enumeration does not prompt for capture.
        void this.refreshDevices();
        return stream;
    }

    showSending(session) {
        const muted = session.stream?.getAudioTracks()[0]?.muted;
        this.setStatus(muted
            ? 'The microphone is temporarily muted or unavailable. Check the device and browser settings.'
            : `Sending: ${session.deviceLabel}`, false, muted ? 'warn' : 'info');
    }

    createSession() {
        return {
            captureId: 1,
            sending: false,
            metrics: { sentFrames: 0, staleFrames: 0, peakBufferedBytes: 0 },
        };
    }

    createAudioContext(session) {
        session.context = new this.Context({ sampleRate: 48000 });
        session.context.onstatechange = () => {
            if (this.current(session) &&
                session.socket?.readyState === WebSocket.OPEN &&
                session.context.state !== 'running') {
                this.fail(session, 'Your browser paused microphone audio. Enable the microphone again when the browser is ready.');
            }
        };
        if (!session.context.audioWorklet) {
            this.fail(session, 'This browser cannot process microphone audio. Try a current version of Firefox, Chrome, or Edge.');
            return false;
        }
        return true;
    }

    async acquireForStart(session) {
        try {
            return await withTimeout(
                this.acquire(session, this.selectedId, session.captureId),
                CAPTURE_TIMEOUT_MS, 'Microphone permission/device acquisition');
        } catch (error) {
            if (this.current(session)) {
                const message = error?.message === 'Microphone permission/device acquisition timed out'
                    ? 'Microphone access timed out. Respond to the browser permission prompt and retry.'
                    : Microphone.captureError(error);
                this.fail(session, message, error);
            }
            return null;
        }
    }

    async prepareAudioProcessing(session, stream, resumed) {
        this.setStatus('Preparing microphone audio…');
        session.timer = setTimeout(() => {
            this.fail(session, 'Microphone audio setup timed out. Refresh the page and try again.');
        }, SETUP_TIMEOUT_MS);
        await resumed;
        if (!this.current(session)) return false;
        await withTimeout(session.context.audioWorklet.addModule(WORKLET_URL),
            SETUP_TIMEOUT_MS, 'AudioWorklet module load');
        if (!this.current(session)) return false;

        session.node = new AudioWorkletNode(session.context, 'web-microphone', {
            numberOfInputs: 1,
            numberOfOutputs: 1,
            outputChannelCount: [1],
        });
        session.node.port.postMessage({ type: 'reset', captureId: session.captureId });
        session.source = session.context.createMediaStreamSource(stream);
        session.node.onprocessorerror = () => {
            this.fail(session, 'Microphone audio processing stopped. Enable the microphone again to retry.');
        };
        return true;
    }

    handleSocketOpen(session) {
        if (!this.current(session)) return;
        clearTimeout(session.timer);
        try {
            session.source.connect(session.node);
            session.node.connect(session.context.destination);
        } catch (error) {
            this.fail(session, 'Microphone audio processing could not start. Enable the microphone again to retry.', error);
            return;
        }
        session.sending = true;
        this.render();
        this.showSending(session);
    }

    handleAudioFrame(session, data) {
        if (!this.current(session) || !session.sending ||
            data?.type !== 'pcm' || data.captureId !== session.captureId) return;
        if (session.context.currentTime - data.time > MAX_FRAME_AGE_SECONDS) {
            session.metrics.staleFrames++;
            return;
        }
        this.send(session, data.pcm);
    }

    connectTransport(session) {
        session.socket = new WebSocket(this.url(), ['binary']);
        session.socket.onopen = () => this.handleSocketOpen(session);
        session.node.port.onmessage = ({ data }) => this.handleAudioFrame(session, data);
        session.socket.onclose = event => this.fail(session, session.sending
            ? 'The microphone stream disconnected. Enable the microphone again to reconnect.'
            : 'Could not open the microphone stream. Another desktop session may be using it. Try again.',
            `close code=${event.code}, clean=${event.wasClean}`);
        session.socket.onerror = event => this.fail(session,
            'Could not connect the microphone stream. Check your connection and sign in again if needed.', event?.type);

        this.setStatus('Connecting the selected microphone…');
        clearTimeout(session.timer);
        session.timer = setTimeout(() => {
            this.fail(session, 'The microphone connection timed out. Check your connection and try again.');
        }, SETUP_TIMEOUT_MS);
        this.render();
    }

    async start() {
        if (this.session || !this.connected || this.unavailable) return;
        const session = this.createSession();
        this.session = session;
        this.render();
        this.setStatus('Waiting for microphone permission. Allow the selected microphone, or cancel.');

        try {
            if (!this.createAudioContext(session)) return;
            // Resume inside the user gesture; observe rejections even if cancelled.
            const resumed = withTimeout(session.context.resume(), SETUP_TIMEOUT_MS, 'AudioContext resume');
            resumed.catch(() => { });

            const stream = await this.acquireForStart(session);
            if (!stream || !this.current(session)) return;
            if (!await this.prepareAudioProcessing(session, stream, resumed)) return;

            // Do not compete with a previous socket that is still closing.
            await this.transportClosed;
            if (!this.current(session)) return;
            this.connectTransport(session);
        } catch (error) {
            this.fail(session, 'Microphone audio could not be started. Refresh the page and try again.', error);
        }
    }

    send(session, pcm) {
        if (!this.current(session) || session.socket?.readyState !== WebSocket.OPEN) return;
        if (!(pcm instanceof ArrayBuffer) || pcm.byteLength !== FRAME_BYTES) {
            this.fail(session, 'Invalid microphone audio frame.', 'Unexpected PCM payload size/type');
            return;
        }
        try {
            const buffered = session.socket.bufferedAmount;
            session.metrics.peakBufferedBytes = Math.max(session.metrics.peakBufferedBytes, buffered);
            if (buffered + pcm.byteLength > MAX_BUFFERED_BYTES) {
                this.fail(session,
                    'The microphone connection is too slow. Check your network, then enable the microphone again.',
                    `buffered=${buffered}, incoming=${pcm.byteLength}, limit=${MAX_BUFFERED_BYTES}`);
                return;
            }
            session.socket.send(pcm);
            session.metrics.sentFrames++;
        } catch (error) {
            this.fail(session, 'The microphone stream could not send audio. Check your connection and try again.', error);
        }
    }

    startSilence(session) {
        if (session.silenceTimer) return;
        const silence = new ArrayBuffer(FRAME_BYTES);
        session.silenceTimer = setInterval(() => this.send(session, silence), FRAME_INTERVAL_MS);
    }

    stopSilence(session) {
        clearInterval(session.silenceTimer);
        session.silenceTimer = null;
    }

    async switchMicrophone() {
        const session = this.session;
        if (!session || session.socket?.readyState !== WebSocket.OPEN) return;
        const captureId = ++session.captureId;
        session.sending = false;
        this.releaseInput(session);
        this.render();
        this.setStatus('Switching microphones. Allow access if prompted, or cancel.');
        // Keep the socket, sending silence while the replacement source opens.
        this.startSilence(session);

        try {
            session.node.port.postMessage({ type: 'reset', captureId });
            const stream = await this.acquire(session, this.selectedId, captureId);
            if (!stream || !this.current(session, captureId)) return;
            session.node.port.postMessage({ type: 'reset', captureId });
            session.source = session.context.createMediaStreamSource(stream);
            session.source.connect(session.node);
            this.stopSilence(session);
            session.sending = true;
            this.render();
            this.showSending(session);
        } catch (error) {
            if (this.current(session, captureId)) this.fail(session,
                error?.name ? Microphone.captureError(error)
                    : 'Could not switch microphones. Enable it again to retry.', error);
        }
    }

    fail(session, message, cause = null) {
        if (!this.current(session)) return;
        Log.Error(`Microphone failure: ${message}${cause ? `; cause=${cause}` : ''}`);
        this.stop(message, true);
        try {
            this.reportError?.(message);
        } catch (error) {
            Log.Error(`Microphone error reporter failed: ${error}`);
        }
        void this.refreshDevices();
    }

    closeTransport(socket) {
        return new Promise(resolve => {
            if (socket.readyState === WebSocket.CLOSED) {
                resolve('closed');
                return;
            }
            let settled = false;
            const finish = outcome => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                if (outcome !== 'closed') Log.Warn(`Microphone transport shutdown: ${outcome}`);
                resolve(outcome);
            };
            const timer = setTimeout(() => finish('timeout'), CLOSE_TIMEOUT_MS);
            socket.addEventListener('close', () => finish('closed'), { once: true });
            try { socket.close(); } catch (error) { finish(`close-error: ${error}`); }
        });
    }

    releaseAudioProcessing(session) {
        if (session.node) {
            session.node.port.onmessage = null;
            session.node.onprocessorerror = null;
            try { session.node.disconnect(); } catch (_) { /* Already disconnected. */ }
        }
        if (session.context) {
            session.context.onstatechange = null;
            try {
                session.context.close().catch(error => Log.Warn(`AudioContext close failed: ${error}`));
            } catch (error) {
                Log.Warn(`AudioContext close failed: ${error}`);
            }
        }
    }

    releaseSession(session) {
        const { sentFrames, staleFrames, peakBufferedBytes } = session.metrics;
        Log.Info(`Microphone session ended: sentFrames=${sentFrames}, staleFrames=${staleFrames}, peakBufferedBytes=${peakBufferedBytes}`);
        clearTimeout(session.timer);
        this.stopSilence(session);
        this.releaseInput(session);
        if (session.socket) {
            session.socket.onopen = null;
            session.socket.onclose = null;
            session.socket.onerror = null;
            this.transportClosed = this.closeTransport(session.socket);
        }
        this.releaseAudioProcessing(session);
    }

    stop(message = 'Microphone off', error = false) {
        const session = this.session;
        this.session = null;
        if (session) this.releaseSession(session);
        this.render();
        this.setStatus(message, error);
    }
}
