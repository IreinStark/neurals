import React from "react";

const VideoComparison = ({ originalUrl, processedUrl, onReset }) => {
  if (!originalUrl && !processedUrl) {
    return null;
  }

  return (
    <div className="mt-4">
      <div className="row">
        <div className="col-md-6 mb-3">
          <h6>Recorded Input</h6>
          {originalUrl ? <video src={originalUrl} controls style={{ width: "100%" }} /> : <p>No input clip</p>}
        </div>
        <div className="col-md-6 mb-3">
          <h6>Processed Output</h6>
          {processedUrl ? (
            <>
              <video src={processedUrl} controls style={{ width: "100%" }} />
              <a className="btn btn-outline-light btn-sm mt-2" href={processedUrl} download>
                Download Styled Video
              </a>
            </>
          ) : (
            <p>Not ready yet</p>
          )}
        </div>
      </div>
      <button type="button" className="btn btn-secondary btn-sm" onClick={onReset}>
        Try Again
      </button>
    </div>
  );
};

export default VideoComparison;

