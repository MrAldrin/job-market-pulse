import type { Readable } from "node:stream";

export const parentPipeKey = "PULSE_PARENT_PIPE";

// The owner holds stdin open. EOF also requests shutdown if the owner crashes.
// The pipe carries no data and exposes no listener to other processes.
export const watchParentPipe = (input: Readable, stop: () => void): (() => void) => {
  let active = true;

  const remove = () => {
    active = false;
    input.off("end", finish);
    input.off("close", finish);
    input.off("error", finish);
    input.pause();
  };

  const finish = () => {
    if (!active) return;
    remove();
    stop();
  };

  if (input.readableEnded || input.destroyed) queueMicrotask(finish);
  else {
    input.once("end", finish);
    input.once("close", finish);
    input.once("error", finish);
    input.resume();
  }

  return remove;
};
