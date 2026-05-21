import React, { useCallback, useEffect, useRef, useState } from "react";

const StylePreview = ({
  modelUrl = "/models/pointilism-10.onnx",
  width = 640,
  height = 360,
  inferenceWidth = 320,
  inferenceHeight = 180,
  onCanvasReady,
  onProcessorReady,
  onStyledFrame,
}) => {
  const displayCanvasRef = useRef(null);
  const workingCanvasRef = useRef(null);
  const workerRef = useRef(null);
  const isBusyRef = useRef(false);
  const [status, setStatus] = useState("loading");
  const [statusMessage, setStatusMessage] = useState("Loading ONNX preview model...");

  // Spawn worker once on mount, terminate on unmount
  useEffect(() => {
    const worker = new Worker("/models/style-preview-worker.js");
    workerRef.current = worker;
    return () => {
      worker.postMessage({ type: "release" });
      worker.terminate();
      workerRef.current = null;
    };
  }, []);

  // Tell the worker to load a new model whenever modelUrl changes
  useEffect(() => {
    const worker = workerRef.current;
    if (!worker) {
      return undefined;
    }
    setStatus("loading");
    setStatusMessage("Loading live preview model...");

    const handleLoad = (event) => {
      const { type, provider, message } = event.data;
      if (type === "ready") {
        setStatus("ready");
        setStatusMessage(`Live preview ready (${provider})`);
      } else if (type === "error") {
        setStatus("fallback");
        setStatusMessage(message || "ONNX unavailable, using fallback");
      }
    };

    worker.addEventListener("message", handleLoad);
    worker.postMessage({ type: "load", modelUrl });

    return () => {
      worker.removeEventListener("message", handleLoad);
    };
  }, [modelUrl]);

  useEffect(() => {
    if (onCanvasReady) {
      onCanvasReady(displayCanvasRef.current);
    }
    return () => {
      if (onCanvasReady) {
        onCanvasReady(null);
      }
    };
  }, [onCanvasReady]);

  const drawFallback = useCallback(
    (sourceCanvas) => {
      const target = displayCanvasRef.current;
      if (!target || !sourceCanvas) {
        return;
      }
      const ctx = target.getContext("2d");
      if (!ctx) {
        return;
      }
      ctx.filter = "grayscale(1)";
      ctx.drawImage(sourceCanvas, 0, 0, width, height);
      ctx.filter = "none";
    },
    [height, width]
  );

  useEffect(() => {
    const processFrame = (sourceCanvas) => {
      if (!sourceCanvas || isBusyRef.current) {
        return;
      }

      const worker = workerRef.current;
      if (!worker || status !== "ready") {
        drawFallback(sourceCanvas);
        return;
      }

      if (!workingCanvasRef.current) {
        workingCanvasRef.current = document.createElement("canvas");
      }
      const workingCanvas = workingCanvasRef.current;
      workingCanvas.width = inferenceWidth;
      workingCanvas.height = inferenceHeight;
      const workCtx = workingCanvas.getContext("2d");
      if (!workCtx) {
        drawFallback(sourceCanvas);
        return;
      }
      workCtx.drawImage(sourceCanvas, 0, 0, inferenceWidth, inferenceHeight);
      const imageData = workCtx.getImageData(0, 0, inferenceWidth, inferenceHeight).data;

      isBusyRef.current = true;

      const handleResult = (event) => {
        const { type, rgba, outWidth, outHeight } = event.data;
        if (type !== "result" && type !== "fallback") {
          return;
        }
        worker.removeEventListener("message", handleResult);
        isBusyRef.current = false;

        if (type === "fallback" || !rgba) {
          drawFallback(sourceCanvas);
          return;
        }

        const target = displayCanvasRef.current;
        if (!target) {
          return;
        }
        const ctx = target.getContext("2d");
        if (!ctx) {
          return;
        }

        const outCanvas = document.createElement("canvas");
        outCanvas.width = outWidth;
        outCanvas.height = outHeight;
        const outCtx = outCanvas.getContext("2d");
        if (outCtx) {
          outCtx.putImageData(new ImageData(rgba, outWidth, outHeight), 0, 0);
          ctx.drawImage(outCanvas, 0, 0, width, height);
        }

        if (onStyledFrame && displayCanvasRef.current) {
          onStyledFrame(displayCanvasRef.current);
        }
      };

      worker.addEventListener("message", handleResult);
      // Transfer the pixel buffer so it's zero-copy into the worker
      worker.postMessage(
        { type: "run", imageData, width: inferenceWidth, height: inferenceHeight },
        [imageData.buffer]
      );
    };

    if (onProcessorReady) {
      onProcessorReady(processFrame);
    }
    return () => {
      if (onProcessorReady) {
        onProcessorReady(null);
      }
    };
  }, [drawFallback, height, inferenceHeight, inferenceWidth, onProcessorReady, onStyledFrame, status, width]);

  return (
    <div>
      <canvas
        ref={displayCanvasRef}
        width={width}
        height={height}
        style={{ width: "100%", borderRadius: "8px", background: "#111" }}
      />
      <small className="neu-muted" style={{ fontSize: "0.75rem", display: "block", marginTop: "6px" }}>
        {status === "loading" ? "Loading model…" : status === "ready" ? "Live inference active" : `Fallback — ${statusMessage}`}
      </small>
    </div>
  );
};

export default StylePreview;
