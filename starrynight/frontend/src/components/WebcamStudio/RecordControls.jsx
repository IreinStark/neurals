import React from "react";

const RecordControls = ({
  isRecording,
  recordingTimeMs,
  maxDurationMs = 30000,
  onStartRecording,
  onStopRecording,
  onProcessFullQuality,
  canProcess,
  statusText,
  isProcessing,
}) => {
  const seconds = Math.floor(recordingTimeMs / 1000);
  const maxSeconds = Math.floor(maxDurationMs / 1000);

  return (
    <div className="mt-3">
      <div className="d-flex align-items-center flex-wrap">
        <button
          type="button"
          className="btn btn-success mr-2 mb-2"
          disabled={isRecording}
          onClick={onStartRecording}
        >
          Start Recording
        </button>
        <button
          type="button"
          className="btn btn-danger mr-2 mb-2"
          disabled={!isRecording}
          onClick={onStopRecording}
        >
          Stop Recording
        </button>
        <button
          type="button"
          className="btn btn-primary mb-2"
          disabled={!canProcess || isRecording || isProcessing}
          onClick={onProcessFullQuality}
        >
          Process Full Quality
        </button>
      </div>
      <p className="mb-1">
        Record: {seconds}s / {maxSeconds}s
      </p>
      <p className="mb-0">Status: {statusText}</p>
    </div>
  );
};

export default RecordControls;
