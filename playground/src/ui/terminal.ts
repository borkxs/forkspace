import type { OutputLine } from "../sim/types";

export type TerminalListener = (lines: OutputLine[]) => void;

export class Terminal {
  private container: HTMLElement;
  private outputEl: HTMLElement;
  private inputEl: HTMLInputElement;
  private promptEl: HTMLElement;
  private history: string[] = [];
  private historyIdx = -1;
  private onCommand: (cmd: string) => void;
  private cwd = "~/git/sb";

  constructor(
    container: HTMLElement,
    onCommand: (cmd: string) => void
  ) {
    this.container = container;
    this.onCommand = onCommand;
    this.container.className = "terminal";
    this.container.innerHTML = `
      <div class="terminal-header">
        <span class="terminal-dot red"></span>
        <span class="terminal-dot yellow"></span>
        <span class="terminal-dot green"></span>
        <span class="terminal-title">forkspace playground</span>
      </div>
      <div class="terminal-body">
        <div class="terminal-output"></div>
        <div class="terminal-input-row">
          <span class="terminal-prompt"></span>
          <input class="terminal-input" type="text" spellcheck="false" autocomplete="off" />
        </div>
      </div>
    `;
    this.outputEl = this.container.querySelector(".terminal-output")!;
    this.inputEl = this.container.querySelector(".terminal-input")!;
    this.promptEl = this.container.querySelector(".terminal-prompt")!;
    this.updatePrompt();
    this.bindEvents();
  }

  private updatePrompt(): void {
    this.promptEl.textContent = `${this.cwd} $ `;
  }

  private bindEvents(): void {
    this.inputEl.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        const val = this.inputEl.value;
        this.echoInput(val);
        this.inputEl.value = "";
        this.historyIdx = -1;
        if (val.trim()) {
          this.history.unshift(val);
          if (this.history.length > 100) this.history.pop();
        }
        this.onCommand(val);
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        if (this.historyIdx < this.history.length - 1) {
          this.historyIdx++;
          this.inputEl.value = this.history[this.historyIdx];
        }
      } else if (e.key === "ArrowDown") {
        e.preventDefault();
        if (this.historyIdx > 0) {
          this.historyIdx--;
          this.inputEl.value = this.history[this.historyIdx];
        } else {
          this.historyIdx = -1;
          this.inputEl.value = "";
        }
      } else if (e.key === "l" && e.ctrlKey) {
        e.preventDefault();
        this.clear();
      }
    });

    this.container.addEventListener("click", () => this.inputEl.focus());
  }

  focus(): void {
    this.inputEl.focus();
  }

  clear(): void {
    this.outputEl.innerHTML = "";
  }

  echoInput(cmd: string): void {
    const line = document.createElement("div");
    line.className = "terminal-line input-echo";
    line.innerHTML = `<span class="prompt-text">${escapeHtml(this.cwd)} $ </span><span class="cmd-text">${escapeHtml(cmd)}</span>`;
    this.outputEl.appendChild(line);
    this.scrollBottom();
  }

  write(lines: OutputLine[]): void {
    for (const line of lines) {
      const el = document.createElement("div");
      el.className = `terminal-line output-${line.kind}`;
      if (line.kind === "env") {
        el.innerHTML = `<pre class="env-block">${escapeHtml(line.text)}</pre>`;
      } else {
        el.textContent = line.text;
      }
      this.outputEl.appendChild(el);
    }
    this.scrollBottom();
  }

  writeBanner(): void {
    const banner = document.createElement("div");
    banner.className = "terminal-banner";
    banner.innerHTML = `
      <div class="banner-title">forkspace playground</div>
      <div class="banner-sub">Simulated terminal — no Docker required</div>
      <div class="banner-hint">Try <code>forkspace help</code> or pick a scenario from the sidebar</div>
    `;
    this.outputEl.appendChild(banner);
  }

  runCommand(cmd: string, animate = true): void {
    if (animate) {
      this.echoInput(cmd);
    }
    this.onCommand(cmd);
  }

  private scrollBottom(): void {
    const body = this.container.querySelector(".terminal-body")!;
    body.scrollTop = body.scrollHeight;
  }
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
