import type { Session } from "../core/session";

interface Props {
  session: Session;
  error: string;
  notice: string;
  status: string;
}

export default function Banners({ session, error, notice, status }: Props) {
  return (
    <>
      {error && (
        <div className="error-banner" role="alert">
          <p>{error}</p>
          {status === "保存失败" && (
            <button
              onClick={() =>
                void session
                  .flush()
                  .then(() => session.setError(""))
                  .catch(() => {})
              }
            >
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
