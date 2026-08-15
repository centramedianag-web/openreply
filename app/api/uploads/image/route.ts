import { NextRequest, NextResponse } from "next/server";
import { put } from "@vercel/blob";
import {
  canManageWorkspace,
  getCurrentWorkspaceContext,
} from "@/lib/workspace-access";

// Uploads are per-request and must never be cached or statically evaluated.
export const dynamic = "force-dynamic";

// Meta accepts png and jpeg image attachments up to 8MB. Rejecting anything
// else here means the campaign cannot be saved with an image Instagram would
// refuse at send time.
const ALLOWED_TYPES = ["image/png", "image/jpeg"];
const MAX_BYTES = 8 * 1024 * 1024;

export async function POST(request: NextRequest) {
  const context = await getCurrentWorkspaceContext();
  if (!context) {
    return NextResponse.json(
      { success: false, error: "Unauthorized" },
      { status: 401 }
    );
  }

  if (!canManageWorkspace(context.role)) {
    return NextResponse.json(
      { success: false, error: "Only owners and admins can upload images" },
      { status: 403 }
    );
  }

  if (!process.env.BLOB_READ_WRITE_TOKEN) {
    return NextResponse.json(
      {
        success: false,
        error:
          "Image storage is not configured. Connect a Vercel Blob store to this project, then redeploy.",
      },
      { status: 500 }
    );
  }

  let file: File | null = null;
  try {
    const form = await request.formData();
    const candidate = form.get("file");
    if (candidate instanceof File) file = candidate;
  } catch {
    return NextResponse.json(
      { success: false, error: "Could not read the uploaded file" },
      { status: 400 }
    );
  }

  if (!file) {
    return NextResponse.json(
      { success: false, error: "No file was uploaded" },
      { status: 400 }
    );
  }

  if (!ALLOWED_TYPES.includes(file.type)) {
    return NextResponse.json(
      {
        success: false,
        error: `Instagram only accepts PNG and JPEG images. That file is ${file.type || "an unknown type"}.`,
      },
      { status: 400 }
    );
  }

  if (file.size > MAX_BYTES) {
    return NextResponse.json(
      {
        success: false,
        error: `That image is ${(file.size / 1024 / 1024).toFixed(1)}MB. Instagram's limit is 8MB.`,
      },
      { status: 400 }
    );
  }

  // Scoped per workspace so one workspace's uploads can never collide with
  // another's. addRandomSuffix keeps two files of the same name apart.
  const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, "_").slice(-80);
  const blob = await put(
    `campaign-images/${context.workspaceId}/${safeName}`,
    file,
    {
      access: "public",
      addRandomSuffix: true,
      contentType: file.type,
    }
  );

  return NextResponse.json({ success: true, url: blob.url });
}
