import React, { useCallback, useEffect, useRef, useState } from "react";
import { Container } from "react-bootstrap";

import AlertBox from "../components/AlertBox";
import WebcamCapture from "../components/WebcamStudio/WebcamCapture";
import StylePreview from "../components/WebcamStudio/StylePreview";
import RecordControls from "../components/WebcamStudio/RecordControls";
import ProcessingStatus from "../components/WebcamStudio/ProcessingStatus";
import VideoComparison from "../components/WebcamStudio/VideoComparison";
import InlineSpinner from "../components/WebcamStudio/InlineSpinner";
import ErrorAlert from "../components/WebcamStudio/ErrorAlert";

const CAPTURE_INTERVAL_MS = 50;
const MAX_RECORDING_MS = 30000;
const STATUS_POLL_INTERVAL_MS = 2000;
const NETWORK_RETRY_SECONDS = 10;
const MAX_NETWORK_RETRIES = 6;

const selectMimeType = () => {
  const options = ["video/webm;codecs=vp9", "video/webm;codecs=vp8", "video/webm"];
  for (const mimeType of options) {
    if (window.MediaRecorder && MediaRecorder.isTypeSupported(mimeType)) {
      return mimeType;
    }
  }
  return "";
};

const WebcamStudio = () => {
  const [isAuth, setIsAuth] = useState(false);
  const [statusText, setStatusText] = useState("Idle");
  const [errorText, setErrorText] = useState("");
  const [successText, setSuccessText] = useState("");
  const [isRecording, setIsRecording] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const [networkRetryCountdown, setNetworkRetryCountdown] = useState(0);
  const [styleOptions, setStyleOptions] = useState([]);
  const [selectedStyle, setSelectedStyle] = useState("");
  const [styleError, setStyleError] = useState("");
  const [recordingTimeMs, setRecordingTimeMs] = useState(0);
  const [recordedBlob, setRecordedBlob] = useState(null);
  const [recordedVideoUrl, setRecordedVideoUrl] = useState("");
  const [processedVideoUrl, setProcessedVideoUrl] = useState("");
  const [jobId, setJobId] = useState("");
  const [jobStatus, setJobStatus] = useState({
    status: "idle",
    progress: 0,
    error: null,
  });

  const streamRef = useRef(null);
  const styleProcessorRef = useRef(null);
  const mediaRecorderRef = useRef(null);
  const chunksRef = useRef([]);
  const timerRef = useRef(null);
  const pollTimeoutRef = useRef(null);
  const retryCountdownRef = useRef(null);

  useEffect(() => {
    if (localStorage.getItem("userToken") !== null) {
      setIsAuth(true);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    const fetchStyles = async () => {
      try {
        const response = await fetch("/style_transfer/webcam-styles/");
        const data = await response.json();
        if (!response.ok) {
          throw new Error(data.error || "Failed to load styles");
        }
        const styles = Array.isArray(data.styles) ? data.styles : [];
        const enabledStyles = styles.filter((item) => item && item.available);
        if (!cancelled) {
          setStyleOptions(enabledStyles);
          if (enabledStyles.length > 0) {
            const defaultStyle = data.default_style;
            const hasDefault = enabledStyles.some((item) => item.id === defaultStyle);
            setSelectedStyle(hasDefault ? defaultStyle : enabledStyles[0].id);
            setStyleError("");
          } else {
            setStyleError("No webcam styles are available.");
          }
        }
      } catch (err) {
        if (!cancelled) {
          setStyleError(err.message || "Failed to load webcam styles.");
        }
      }
    };
    fetchStyles();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(
    () => () => {
      if (recordedVideoUrl) {
        URL.revokeObjectURL(recordedVideoUrl);
      }
    },
    [recordedVideoUrl]
  );

  useEffect(
    () => () => {
      if (timerRef.current) {
        window.clearInterval(timerRef.current);
      }
      if (pollTimeoutRef.current) {
        window.clearTimeout(pollTimeoutRef.current);
      }
      if (retryCountdownRef.current) {
        window.clearInterval(retryCountdownRef.current);
      }
      if (streamRef.current) {
        streamRef.current.getTracks().forEach((track) => track.stop());
      }
    },
    []
  );

  const onStreamReady = useCallback((stream) => {
    streamRef.current = stream;
  }, []);

  const onProcessorReady = useCallback((processor) => {
    styleProcessorRef.current = processor;
  }, []);

  const onFrame = useCallback((frameCanvas) => {
    if (styleProcessorRef.current) {
      styleProcessorRef.current(frameCanvas);
    }
  }, []);

  const stopRecording = useCallback(() => {
    if (timerRef.current) {
      window.clearInterval(timerRef.current);
      timerRef.current = null;
    }
    const recorder = mediaRecorderRef.current;
    if (recorder && recorder.state !== "inactive") {
      recorder.stop();
    }
    setIsRecording(false);
    setStatusText("Recording stopped");
  }, []);

  const startRecording = useCallback(() => {
    if (!streamRef.current) {
      setErrorText("Webcam stream is not ready yet.");
      return;
    }
    if (!window.MediaRecorder) {
      setErrorText("MediaRecorder is not supported in this browser.");
      return;
    }

    setErrorText("");
    setSuccessText("");
    setStatusText("Recording...");
    setProcessedVideoUrl("");
    setJobId("");
    setJobStatus({ status: "idle", progress: 0, error: null });
    setRecordingTimeMs(0);

    chunksRef.current = [];
    const mimeType = selectMimeType();
    const recorder = mimeType
      ? new MediaRecorder(streamRef.current, { mimeType })
      : new MediaRecorder(streamRef.current);
    mediaRecorderRef.current = recorder;

    recorder.ondataavailable = (event) => {
      if (event.data && event.data.size > 0) {
        chunksRef.current.push(event.data);
      }
    };
    recorder.onstop = () => {
      const blob = new Blob(chunksRef.current, {
        type: recorder.mimeType || "video/webm",
      });
      if (recordedVideoUrl) {
        URL.revokeObjectURL(recordedVideoUrl);
      }
      setRecordedBlob(blob);
      setRecordedVideoUrl(URL.createObjectURL(blob));
      setStatusText("Recording ready for full-quality processing");
    };

    recorder.start(500);
    setIsRecording(true);

    timerRef.current = window.setInterval(() => {
      setRecordingTimeMs((prev) => {
        const next = prev + CAPTURE_INTERVAL_MS;
        if (next >= MAX_RECORDING_MS) {
          stopRecording();
          return MAX_RECORDING_MS;
        }
        return next;
      });
    }, CAPTURE_INTERVAL_MS);
  }, [recordedVideoUrl, stopRecording]);

  const processFullQuality = useCallback(async () => {
    if (!recordedBlob) {
      setErrorText("Record a clip first.");
      return;
    }
    if (!selectedStyle) {
      setErrorText("Select a style before processing.");
      return;
    }

    setErrorText("");
    setSuccessText("");
    setNetworkRetryCountdown(0);
    if (pollTimeoutRef.current) {
      window.clearTimeout(pollTimeoutRef.current);
      pollTimeoutRef.current = null;
    }
    if (retryCountdownRef.current) {
      window.clearInterval(retryCountdownRef.current);
      retryCountdownRef.current = null;
    }
    setIsUploading(true);
    setStatusText("Uploading...");

    const formData = new FormData();
    const ext = recordedBlob.type.includes("mp4") ? "mp4" : "webm";
    formData.append("video", recordedBlob, `webcam-recording.${ext}`);
    formData.append("style", selectedStyle);

    try {
      const response = await fetch("/style_transfer/webcam-video/", {
        method: "POST",
        body: formData,
      });
      let data = {};
      try {
        data = await response.json();
      } catch {
        data = {};
      }
      if (!response.ok) {
        throw new Error(data.error || "Upload failed");
      }

      setJobId(data.job_id);
      setJobStatus({
        status: data.status || "queued",
        progress: 0,
        error: null,
      });
      setStatusText("Queued for processing");
    } catch (err) {
      setErrorText(err.message);
      setStatusText("Upload failed");
    } finally {
      setIsUploading(false);
    }
  }, [recordedBlob, selectedStyle]);

  useEffect(() => {
    if (!jobId) {
      return undefined;
    }

    let isCancelled = false;
    let networkFailures = 0;

    const clearRetryTimer = () => {
      if (retryCountdownRef.current) {
        window.clearInterval(retryCountdownRef.current);
        retryCountdownRef.current = null;
      }
    };

    const clearPollTimer = () => {
      if (pollTimeoutRef.current) {
        window.clearTimeout(pollTimeoutRef.current);
        pollTimeoutRef.current = null;
      }
    };

    const schedulePoll = (delayMs = STATUS_POLL_INTERVAL_MS) => {
      clearPollTimer();
      pollTimeoutRef.current = window.setTimeout(() => {
        if (!isCancelled) {
          poll();
        }
      }, delayMs);
    };

    const startNetworkRetryCountdown = () => {
      clearRetryTimer();
      setNetworkRetryCountdown(NETWORK_RETRY_SECONDS);
      setStatusText(`Network error. Retry in ${NETWORK_RETRY_SECONDS}s...`);
      retryCountdownRef.current = window.setInterval(() => {
        setNetworkRetryCountdown((previous) => {
          const next = previous - 1;
          if (next <= 0) {
            clearRetryTimer();
            schedulePoll(0);
            return 0;
          }
          setStatusText(`Network error. Retry in ${next}s...`);
          return next;
        });
      }, 1000);
    };

    const poll = async () => {
      try {
        const response = await fetch(`/style_transfer/video-status/${jobId}/`);
        let data = {};
        try {
          data = await response.json();
        } catch {
          data = {};
        }
        if (!response.ok) {
          throw new Error(data.error || "Failed to fetch status");
        }

        networkFailures = 0;
        setNetworkRetryCountdown(0);

        setJobStatus({
          status: data.status,
          progress: data.progress || 0,
          error: data.error || null,
        });

        if (data.status === "completed") {
          setStatusText("Processing complete");
          setProcessedVideoUrl(data.video_url || "");
          setSuccessText("Styled video ready. You can preview or download it now.");
          clearPollTimer();
          clearRetryTimer();
        } else if (data.status === "failed") {
          setStatusText("Processing failed");
          setErrorText(data.error || "Unknown processing error");
          clearPollTimer();
          clearRetryTimer();
        } else {
          setStatusText(`Processing... ${data.progress || 0}%`);
          schedulePoll();
        }
      } catch (err) {
        networkFailures += 1;
        if (networkFailures > MAX_NETWORK_RETRIES) {
          setErrorText(`Network error. Polling stopped after ${MAX_NETWORK_RETRIES} retries.`);
          setStatusText("Status polling stopped");
          clearPollTimer();
          clearRetryTimer();
          return;
        }
        startNetworkRetryCountdown();
      }
    };

    poll();
    return () => {
      isCancelled = true;
      clearPollTimer();
      clearRetryTimer();
    };
  }, [jobId]);

  const resetCapture = useCallback(() => {
    if (pollTimeoutRef.current) {
      window.clearTimeout(pollTimeoutRef.current);
      pollTimeoutRef.current = null;
    }
    if (retryCountdownRef.current) {
      window.clearInterval(retryCountdownRef.current);
      retryCountdownRef.current = null;
    }
    setStatusText("Idle");
    setErrorText("");
    setSuccessText("");
    setIsUploading(false);
    setNetworkRetryCountdown(0);
    setIsRecording(false);
    setRecordingTimeMs(0);
    setRecordedBlob(null);
    if (recordedVideoUrl) {
      URL.revokeObjectURL(recordedVideoUrl);
    }
    setRecordedVideoUrl("");
    setProcessedVideoUrl("");
    setJobId("");
    setJobStatus({ status: "idle", progress: 0, error: null });
  }, [recordedVideoUrl]);

  return (
    <Container className="py-4">
      {isAuth !== true ? (
        <AlertBox variant="danger" children="login to continue" />
      ) : (
        <>
          <h2 className="mb-3">Hybrid Webcam Studio</h2>
          <div className="row">
            <div className="col-lg-6 mb-3">
              <h5>Original Feed</h5>
              <WebcamCapture
                captureInterval={CAPTURE_INTERVAL_MS}
                onFrame={onFrame}
                onStreamReady={onStreamReady}
              />
            </div>
            <div className="col-lg-6 mb-3">
              <h5>Styled Preview</h5>
              <StylePreview onProcessorReady={onProcessorReady} />
            </div>
          </div>

          <RecordControls
            isRecording={isRecording}
            recordingTimeMs={recordingTimeMs}
            maxDurationMs={MAX_RECORDING_MS}
            onStartRecording={startRecording}
            onStopRecording={stopRecording}
            onProcessFullQuality={processFullQuality}
            canProcess={Boolean(recordedBlob) && Boolean(selectedStyle)}
            statusText={statusText}
            isProcessing={isUploading || jobStatus.status === "queued" || jobStatus.status === "processing"}
          />

          <div className="mt-3">
            <label htmlFor="webcam-style-select" className="d-block mb-1">
              Full-Quality Style
            </label>
            <select
              id="webcam-style-select"
              className="form-control"
              value={selectedStyle}
              onChange={(event) => setSelectedStyle(event.target.value)}
              disabled={isUploading || jobStatus.status === "queued" || jobStatus.status === "processing"}
            >
              {styleOptions.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.label}
                </option>
              ))}
            </select>
            {styleError ? <small className="text-danger d-block mt-1">{styleError}</small> : null}
          </div>

          {isUploading ? <InlineSpinner label="Uploading clip..." /> : null}

          {jobStatus.status === "queued" || jobStatus.status === "processing" ? (
            <InlineSpinner label={`Processing video... ${jobStatus.progress || 0}%`} />
          ) : null}

          {networkRetryCountdown > 0 ? (
            <AlertBox variant="warning">{`Network error. Retry in ${networkRetryCountdown}s...`}</AlertBox>
          ) : null}

          <ErrorAlert message={errorText} onRetry={recordedBlob ? processFullQuality : null} />

          {successText ? <AlertBox variant="success">{successText}</AlertBox> : null}

          <ProcessingStatus
            jobId={jobId}
            status={jobStatus.status}
            progress={jobStatus.progress}
            error={jobStatus.error}
          />

          <VideoComparison
            originalUrl={recordedVideoUrl}
            processedUrl={processedVideoUrl}
            onReset={resetCapture}
          />
        </>
      )}
    </Container>
  );
};

export default WebcamStudio;
