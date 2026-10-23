/**
 * The letter of a Ctrl+<letter> key, lower case, also when an input method
 * reports the key as "Process" (then by its position, `event.code`).
 */
export function letterOf(event: KeyboardEvent) {
  if (/^[a-z]$/i.test(event.key)) return event.key.toLowerCase();
  return /^Key([A-Z])$/.exec(event.code)?.[1].toLowerCase();
}
