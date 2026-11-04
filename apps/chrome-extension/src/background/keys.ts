// Key name parsing for the `key` tool: "Enter", "ctrl+a", sequences separated by spaces.

export interface KeySpec { key: string; code: string; vk: number; text?: string; modifiers: number; commands?: string[] }

const MOD: Record<string, number> = { alt: 1, option: 1, ctrl: 2, control: 2, meta: 4, cmd: 4, command: 4, shift: 8 };

const NAMED: Record<string, { key: string; code: string; vk: number; text?: string }> = {
  enter: { key: "Enter", code: "Enter", vk: 13, text: "\r" },
  return: { key: "Enter", code: "Enter", vk: 13, text: "\r" },
  tab: { key: "Tab", code: "Tab", vk: 9 },
  escape: { key: "Escape", code: "Escape", vk: 27 },
  esc: { key: "Escape", code: "Escape", vk: 27 },
  backspace: { key: "Backspace", code: "Backspace", vk: 8 },
  delete: { key: "Delete", code: "Delete", vk: 46 },
  space: { key: " ", code: "Space", vk: 32, text: " " },
  arrowup: { key: "ArrowUp", code: "ArrowUp", vk: 38 },
  up: { key: "ArrowUp", code: "ArrowUp", vk: 38 },
  arrowdown: { key: "ArrowDown", code: "ArrowDown", vk: 40 },
  down: { key: "ArrowDown", code: "ArrowDown", vk: 40 },
  arrowleft: { key: "ArrowLeft", code: "ArrowLeft", vk: 37 },
  left: { key: "ArrowLeft", code: "ArrowLeft", vk: 37 },
  arrowright: { key: "ArrowRight", code: "ArrowRight", vk: 39 },
  right: { key: "ArrowRight", code: "ArrowRight", vk: 39 },
  home: { key: "Home", code: "Home", vk: 36 },
  end: { key: "End", code: "End", vk: 35 },
  pageup: { key: "PageUp", code: "PageUp", vk: 33 },
  pagedown: { key: "PageDown", code: "PageDown", vk: 34 },
};

const EDIT_COMMANDS: Record<string, string> = { a: "selectAll", c: "copy", v: "paste", x: "cut", z: "undo" };

export function parseKeys(input: string): KeySpec[] {
  const specs: KeySpec[] = [];
  for (const chord of input.trim().split(/\s+/).filter(Boolean)) {
    const parts = chord.length > 1 ? chord.split("+").filter(Boolean) : [chord];
    let modifiers = 0;
    let main = "";
    for (const part of parts) {
      const m = MOD[part.toLowerCase()];
      if (m !== undefined && parts.length > 1 && part !== parts[parts.length - 1]) modifiers |= m;
      else main = part;
    }
    if (!main) throw new Error(`Cannot parse key "${chord}"`);
    const named = NAMED[main.toLowerCase()];
    let spec: KeySpec;
    if (named) {
      spec = { ...named, modifiers };
    } else if (main.length === 1) {
      const upper = main.toUpperCase();
      const isLetter = /[a-z]/i.test(main);
      const isDigit = /[0-9]/.test(main);
      spec = { key: main, code: isLetter ? `Key${upper}` : isDigit ? `Digit${main}` : "", vk: upper.charCodeAt(0), text: main, modifiers };
    } else {
      throw new Error(`Unknown key "${main}"`);
    }
    if (modifiers & (1 | 2 | 4)) {
      delete spec.text;
      const command = (modifiers & (2 | 4)) ? EDIT_COMMANDS[main.toLowerCase()] : undefined;
      if (command) spec.commands = [command];
    }
    specs.push(spec);
  }
  if (specs.length === 0) throw new Error("No key given");
  return specs;
}
