"use client";

import { useEffect, useRef, useState, type MutableRefObject } from "react";

/**
 * Finger/stylus signature pad.
 *
 * Pointer events (not mouse/touch pairs) so one code path covers finger,
 * stylus and mouse. `touch-none` stops the browser scrolling the page while
 * the technician draws, which is the difference between a usable pad and an
 * unusable one on a phone.
 *
 * The canvas element is owned by the PARENT through `canvasRef`: exporting the
 * drawing is the parent's job (it also owns the signer name and the request),
 * and passing the ref down keeps that in one place instead of duplicating
 * submit logic here.
 */
export function SignatureCanvas({
  canvasRef,
  onChange,
  disabled,
}: {
  canvasRef: MutableRefObject<HTMLCanvasElement | null>;
  onChange: (hasDrawing: boolean) => void;
  disabled?: boolean;
}) {
  const drawing = useRef(false);
  const [hasDrawing, setHasDrawing] = useState(false);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    // Size the backing store to the CSS box so strokes are not stretched.
    const rect = canvas.getBoundingClientRect();
    canvas.width = Math.max(1, Math.floor(rect.width));
    canvas.height = Math.max(1, Math.floor(rect.height));
    const ctx = canvas.getContext("2d");
    if (ctx) {
      // Opaque white background: a transparent PNG signature is invisible on a
      // white report.
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.lineWidth = 2.5;
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      ctx.strokeStyle = "#0f172a";
    }
  }, [canvasRef]);

  function pos(e: React.PointerEvent<HTMLCanvasElement>) {
    const canvas = canvasRef.current;
    if (!canvas) return { x: 0, y: 0 };
    const rect = canvas.getBoundingClientRect();
    return {
      x: ((e.clientX - rect.left) / rect.width) * canvas.width,
      y: ((e.clientY - rect.top) / rect.height) * canvas.height,
    };
  }

  function start(e: React.PointerEvent<HTMLCanvasElement>) {
    if (disabled) return;
    const ctx = canvasRef.current?.getContext("2d");
    if (!ctx) return;
    drawing.current = true;
    canvasRef.current?.setPointerCapture(e.pointerId);
    const p = pos(e);
    ctx.beginPath();
    ctx.moveTo(p.x, p.y);
  }

  function move(e: React.PointerEvent<HTMLCanvasElement>) {
    if (!drawing.current || disabled) return;
    const ctx = canvasRef.current?.getContext("2d");
    if (!ctx) return;
    const p = pos(e);
    ctx.lineTo(p.x, p.y);
    ctx.stroke();
    if (!hasDrawing) {
      setHasDrawing(true);
      onChange(true);
    }
  }

  function end() {
    drawing.current = false;
  }

  function clear() {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    setHasDrawing(false);
    onChange(false);
  }

  return (
    <div className="space-y-2">
      <canvas
        ref={canvasRef}
        onPointerDown={start}
        onPointerMove={move}
        onPointerUp={end}
        onPointerLeave={end}
        aria-label="Área de assinatura"
        data-testid="signature-canvas"
        className="h-40 w-full touch-none rounded-xl border-2 border-dashed border-slate-300 bg-white"
      />
      <button
        type="button"
        onClick={clear}
        disabled={disabled || !hasDrawing}
        className="rounded-lg border border-slate-300 px-3 py-2 text-sm font-medium text-slate-700 disabled:cursor-not-allowed disabled:opacity-50"
      >
        Limpar
      </button>
    </div>
  );
}

/** Exports a canvas as a PNG blob, or null if the browser refuses. */
export function canvasToPngBlob(
  canvas: HTMLCanvasElement,
): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
}
