// Starts the background job loop (claude -p reviews) once per server process.
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { startJobLoop } = await import("./lib/server/jobs");
  await import("./lib/server/projects"); // registers the "review" handler
  startJobLoop();
}
