import path from "node:path";

const MEMORY_DIR = path.resolve(import.meta.dir, "../../../memory");

export async function handleMemoryList(): Promise<Response> {
  const files: string[] = [];
  const glob = new Bun.Glob("**/*");

  for await (const entry of glob.scan({ cwd: MEMORY_DIR })) {
    files.push(entry);
  }

  files.sort();
  return Response.json({ files });
}

export async function handleMemoryRead(filePath: string): Promise<Response> {
  // Path traversal protection
  if (filePath.includes("..") || filePath.startsWith("/")) {
    return Response.json({ error: "invalid path" }, { status: 400 });
  }

  const fullPath = path.resolve(MEMORY_DIR, filePath);
  if (!fullPath.startsWith(MEMORY_DIR)) {
    return Response.json({ error: "invalid path" }, { status: 400 });
  }

  const file = Bun.file(fullPath);
  if (!(await file.exists())) {
    return Response.json({ error: "file not found" }, { status: 404 });
  }

  const content = await file.text();
  return Response.json({ path: filePath, content });
}
