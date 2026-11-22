declare module 'opus-recorder' {
  interface RecorderConfig {
    encoderPath: string;
    sourceNode?: MediaStreamAudioSourceNode;
    encoderSampleRate?: number;
    numberOfChannels?: number;
    encoderApplication?: 2048 | 2049 | 2051;
    encoderBitRate?: number;
    streamPages?: boolean;
    maxFramesPerPage?: number;
    mediaTrackConstraints?: boolean | MediaTrackConstraints;
    monitorGain?: number;
    recordingGain?: number;
  }
  export default class Recorder {
    constructor(config: RecorderConfig);
    static isRecordingSupported(): boolean;
    ondataavailable: (data: Uint8Array) => void;
    onstart: () => void;
    onstop: () => void;
    start(): Promise<void>;
    stop(): Promise<void>;
    close(): Promise<void>;
    encodedSamplePosition: number;
  }
}

declare module 'opus-recorder/dist/encoderWorker.min.js?url' {
  const url: string;
  export default url;
}
