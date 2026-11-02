import type { Session } from "../core/session";
import { progressText, type ImportProgress } from "../core/upload";

interface Props {
  session: Session;
  error: string;
  notice: string;
  saveFailed: boolean;
  /** What a batch of imports with a large file or a folder is inserting (useImageImport `batchProgress`). */
  importProgress: ImportProgress | null;
}

export default function Banners({
  session,
  error,
  notice,
  saveFailed,
  importProgress,
}: Props) {
  return (
    <>
      {importProgress && (
        <div className="import-banner" role="status">
          <span>{progressText(importProgress)}</span>
          {/* The bar keeps its place for an item without a percent, empty. */}
          <div className="import-progress" aria-hidden="true">
            {importProgress.percent !== null && (
              <div style={{ width: `${importProgress.percent}%` }} />
            )}
          </div>
        </div>
      )}
      {error && (
        <div className="error-banner" role="alert">
          <p>{error}</p>
          {saveFailed && (
            <button onClick={() => void session.saveDocument()}>
              重试保存
            </button>
          )}
          <button
            aria-label="关闭错误提示"
            onClick={() => session.setError("")}
          >
            ×
          </button>
        </div>
      )}
      {notice && (
        <div className="notice-banner" role="status">
          <span>{notice}</span>
          <button aria-label="关闭提示" onClick={() => session.setNotice("")}>
            ×
          </button>
        </div>
      )}
    </>
  );
}
