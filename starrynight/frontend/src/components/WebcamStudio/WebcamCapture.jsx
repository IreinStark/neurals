import React, { useEffect, useRef, useState } from "react";

const WebcamCapture = ({
  onFrame,
  onStreamReady,
  captureInterval = 50,
  width = 640,
  height = 480,
  previewWidth = 640,
  previewHeight = 360,
}) => {
  const videoRef = useRef(null);
  const frameCanvasRef = useRef(null);
  const timerRef = useRef(null);
  const [error, setError] = useState("");

  useEffect(() => {
    let stream = null;

    const start = async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: { width, height },
          audio: false,
        });
        setError("");

        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          await videoRef.current.play();
        }
        if (onStreamReady) {
          onStreamReady(stream);
        }

        timerRef.current = window.setInterval(() => {
          if (!videoRef.current || !frameCanvasRef.current) {
            return;
          }
          const ctx = frameCanvasRef.current.getContext("2d");
          if (!ctx) {
            return;
          }
          ctx.drawImage(videoRef.current, 0, 0, previewWidth, previewHeight);
          if (onFrame) {
            onFrame(frameCanvasRef.current);
          }
        }, captureInterval);
      } catch (err) {
        setError("Webcam access denied or unavailable.");
      }
    };

    start();

    return () => {
      if (timerRef.current) {
        window.clearInterval(timerRef.current);
      }
      if (stream) {
        stream.getTracks().forEach((track) => track.stop());
      }
      if (onStreamReady) {
        onStreamReady(null);
      }
    };
  }, [captureInterval, height, onFrame, onStreamReady, previewHeight, previewWidth, width]);

  return (
    <div>
      {error ? <div className="alert alert-danger">{error}</div> : null}
      <video
        ref={videoRef}
        playsInline
        muted
        autoPlay
        style={{ width: "100%", borderRadius: "8px" }}
      />
      <canvas
        ref={frameCanvasRef}
        width={previewWidth}
        height={previewHeight}
        style={{ display: "none" }}
      />
    </div>
  );
};

export default WebcamCapture;

