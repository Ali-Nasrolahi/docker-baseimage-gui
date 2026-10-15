const FRAME_SAMPLES = 960;
const BYTES_PER_SAMPLE = 2;

class MicrophoneProcessor extends AudioWorkletProcessor {
    constructor() {
        super();

        this.captureId = 0;
        this.reset();

        this.port.onmessage = ({ data }) => {
            if (data?.type !== 'reset' ||
                !Number.isSafeInteger(data.captureId) ||
                data.captureId < 0) {
                return;
            }

            this.captureId = data.captureId;
            this.reset();
        };
    }

    reset() {
        this.frame = new ArrayBuffer(FRAME_SAMPLES * BYTES_PER_SAMPLE);
        this.view = new DataView(this.frame);
        this.count = 0;
    }

    process(inputs) {
        const channels = inputs[0];
        if (!channels?.length) return true;

        const length = channels[0].length;

        for (let i = 0; i < length; i++) {
            let sample = 0;

            for (const channel of channels) {
                sample += channel[i] ?? 0;
            }

            this.writeSample(sample / channels.length);
        }

        return true;
    }

    writeSample(sample) {
        const safe = Number.isFinite(sample) ? sample : 0;
        const clipped = Math.max(-1, Math.min(1, safe));

        const pcm = Math.round(
            clipped * (clipped < 0 ? 32768 : 32767)
        );

        this.view.setInt16(this.count * BYTES_PER_SAMPLE, pcm, true);

        if (++this.count === FRAME_SAMPLES) {
            this.port.postMessage({
                type: 'pcm',
                pcm: this.frame,
                time: currentTime,
                captureId: this.captureId,
            }, [this.frame]);

            this.reset();
        }
    }
}

registerProcessor('web-microphone', MicrophoneProcessor);
