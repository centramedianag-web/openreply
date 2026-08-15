/**
 * Validation for campaign image URLs.
 *
 * Meta fetches the image from its own servers when the DM is sent, so a URL
 * that works in a browser is not necessarily one that works here: a Google
 * Drive or Dropbox share page returns HTML, and a link behind a login returns
 * a redirect to a sign-in form. Either way Meta rejects the attachment at send
 * time, hours after the campaign was saved, and the only trace is a line in
 * the worker log.
 *
 * Checking at save time turns that into an error the person sees while they
 * still have the URL in their clipboard.
 */

// Meta accepts png and jpeg for image attachments, up to 8MB.
const ALLOWED_CONTENT_TYPES = ["image/png", "image/jpeg", "image/jpg"];
const MAX_BYTES = 8 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 8000;

export type ImageUrlCheck = { ok: true } | { ok: false; reason: string };

export function isHttpsUrl(value: string): boolean {
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * Fetch the URL's headers and confirm it really serves a PNG or JPEG that is
 * small enough. Uses HEAD first and falls back to a ranged GET, because some
 * hosts (S3 pre-signed URLs among them) reject HEAD outright.
 */
export async function checkImageUrl(url: string): Promise<ImageUrlCheck> {
  if (!isHttpsUrl(url)) {
    return { ok: false, reason: "Image URL must start with https://" };
  }

  let response: Response;
  try {
    response = await fetchHeaders(url, "HEAD");
    if (response.status === 405 || response.status === 501) {
      response = await fetchHeaders(url, "GET");
    }
  } catch {
    return {
      ok: false,
      reason:
        "Could not reach that image URL. It has to be public — Instagram downloads it from its own servers, not from your browser.",
    };
  }

  if (!response.ok) {
    return {
      ok: false,
      reason: `That image URL returned HTTP ${response.status}. It has to be public, with no login.`,
    };
  }

  const contentType = (response.headers.get("content-type") ?? "")
    .split(";")[0]
    .trim()
    .toLowerCase();

  if (!ALLOWED_CONTENT_TYPES.includes(contentType)) {
    return {
      ok: false,
      reason: contentType.startsWith("text/")
        ? "That link returns a web page, not an image file. Share pages from Google Drive and Dropbox do this — you need a direct link ending in .jpg or .png."
        : `Instagram only accepts PNG and JPEG images. That URL returned "${contentType || "an unknown type"}".`,
    };
  }

  const length = Number(response.headers.get("content-length") ?? 0);
  if (length > MAX_BYTES) {
    return {
      ok: false,
      reason: `That image is ${(length / 1024 / 1024).toFixed(1)}MB. Instagram's limit is 8MB.`,
    };
  }

  return { ok: true };
}

async function fetchHeaders(url: string, method: "HEAD" | "GET") {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, {
      method,
      redirect: "follow",
      // Ask for a single byte so a GET fallback does not pull the whole file.
      headers: method === "GET" ? { Range: "bytes=0-0" } : undefined,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}
