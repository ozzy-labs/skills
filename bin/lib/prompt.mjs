// Tiny interactive confirmation helper shared by the CLI verbs.

/**
 * Ask a yes/no question. Returns true when `force` is set, or when stdin is a
 * TTY and the user answers y/yes. Non-TTY sessions return false (never block).
 *
 * @param {string} message
 * @param {boolean} [force]
 * @returns {Promise<boolean>}
 */
export async function confirm(message, force = false) {
  if (force) return true;
  if (!process.stdin.isTTY) return false;
  process.stdout.write(`${message} [y/N] `);
  return await new Promise((resolve) => {
    let buf = "";
    const onData = (chunk) => {
      buf += chunk.toString();
      if (buf.includes("\n")) {
        process.stdin.off("data", onData);
        process.stdin.pause();
        const answer = buf.trim().toLowerCase();
        resolve(answer === "y" || answer === "yes");
      }
    };
    process.stdin.resume();
    process.stdin.on("data", onData);
  });
}
