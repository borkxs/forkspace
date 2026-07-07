import { SCENARIOS, type Scenario } from "./scenarios";
import {
  createSimulator,
  parseCliInput,
  resetSimulator,
  runCommand,
  type Simulator,
} from "./sim/engine";
import type { CommandResult } from "./sim/types";
import { GuiPanel, type CommandName } from "./ui/gui";
import { Terminal } from "./ui/terminal";
import { YamlEditor } from "./ui/yaml-editor";

export class App {
  private sim: Simulator;
  private terminal!: Terminal;
  private gui!: GuiPanel;
  private yamlEditor!: YamlEditor;
  private activeScenario: Scenario | null = null;
  private stepIdx = 0;
  private scenarioEl!: HTMLElement;
  private stepEl!: HTMLElement;

  constructor(private root: HTMLElement) {
    this.sim = createSimulator();
    this.render();
    this.terminal.writeBanner();
  }

  private render(): void {
    this.root.innerHTML = `
      <header class="app-header">
        <div class="brand">
          <span class="brand-icon">⎇</span>
          <div>
            <h1>forkspace playground</h1>
            <p>Learn the CLI through guided scenarios — or drive every command from the panel</p>
          </div>
        </div>
        <div class="header-actions">
          <button type="button" class="btn btn-ghost" id="reset-btn">Reset simulation</button>
        </div>
      </header>
      <div class="app-layout">
        <aside class="sidebar">
          <section class="sidebar-section">
            <h2>Scenarios</h2>
            <div class="scenario-list" id="scenario-list"></div>
          </section>
          <section class="sidebar-section scenario-guide" id="scenario-guide" hidden>
            <h2>Guide</h2>
            <div id="step-content"></div>
          </section>
        </aside>
        <main class="main-panel">
          <div id="terminal-mount"></div>
        </main>
        <aside class="right-panel">
          <div id="yaml-mount"></div>
          <div id="gui-mount"></div>
        </aside>
      </div>
    `;

    const termMount = this.root.querySelector("#terminal-mount")!;
    const guiMount = this.root.querySelector("#gui-mount")!;
    const yamlMount = this.root.querySelector("#yaml-mount")!;
    this.scenarioEl = this.root.querySelector("#scenario-list")!;
    this.stepEl = this.root.querySelector("#step-content")!;
    const guideSection = this.root.querySelector("#scenario-guide")!;

    this.terminal = new Terminal(termMount, (cmd) => this.handleCommand(cmd));
    this.gui = new GuiPanel(guiMount, this.sim, (cmd) => {
      this.terminal.runCommand(cmd);
    });
    this.yamlEditor = new YamlEditor(yamlMount, this.sim, () => {
      this.gui.refresh();
    });

    this.renderScenarios();

    this.root.querySelector("#reset-btn")!.addEventListener("click", () => {
      resetSimulator(this.sim);
      this.activeScenario = null;
      this.stepIdx = 0;
      guideSection.hidden = true;
      this.terminal.clear();
      this.terminal.writeBanner();
      this.gui.refresh();
      this.yamlEditor.refresh();
      this.renderScenarios();
    });
  }

  private renderScenarios(): void {
    this.scenarioEl.innerHTML = SCENARIOS.map(
      (s) => `
      <button type="button" class="scenario-card ${this.activeScenario?.id === s.id ? "active" : ""}" data-id="${s.id}">
        <span class="scenario-title">${s.title}</span>
        <span class="scenario-sub">${s.subtitle}</span>
      </button>
    `
    ).join("");

    this.scenarioEl.querySelectorAll(".scenario-card").forEach((btn) => {
      btn.addEventListener("click", () => {
        const id = (btn as HTMLElement).dataset.id!;
        this.startScenario(SCENARIOS.find((s) => s.id === id)!);
      });
    });
  }

  private startScenario(scenario: Scenario): void {
    resetSimulator(this.sim, { freshWorkspace: scenario.freshWorkspace });
    this.activeScenario = scenario;
    this.stepIdx = 0;
    const guideSection = this.root.querySelector("#scenario-guide")!;
    guideSection.hidden = false;
    this.terminal.clear();
    this.terminal.writeBanner();
    this.gui.refresh();
    this.yamlEditor.refresh();
    this.renderScenarios();
    this.renderStep();
    this.terminal.write([
      {
        kind: "stdout",
        text: `── Scenario: ${scenario.title} ──`,
      },
    ]);
    if (scenario.freshWorkspace) {
      this.terminal.write([
        {
          kind: "stdout",
          text: "  (fresh workspace — no forkspace.yml yet)",
        },
      ]);
    }
  }

  private renderStep(): void {
    if (!this.activeScenario) return;
    const step = this.activeScenario.steps[this.stepIdx];
    const total = this.activeScenario.steps.length;

    this.stepEl.innerHTML = `
      <div class="step-progress">Step ${this.stepIdx + 1} of ${total}</div>
      <h3 class="step-title">${step.title}</h3>
      <p class="step-desc">${step.description}</p>
      ${step.hint ? `<p class="step-hint">${step.hint}</p>` : ""}
      ${step.command ? `<code class="step-cmd">${step.command}</code>` : ""}
      <div class="step-actions">
        ${
          step.action === "edit-yaml"
            ? `<button type="button" class="btn btn-primary" id="focus-editor">Open editor</button>
               <button type="button" class="btn btn-ghost" id="continue-step">Continue →</button>`
            : `<button type="button" class="btn btn-primary" id="run-step">Run this step</button>`
        }
        ${this.stepIdx < total - 1 && step.action !== "edit-yaml" ? `<button type="button" class="btn btn-ghost" id="next-step">Skip →</button>` : ""}
        ${this.stepIdx > 0 ? `<button type="button" class="btn btn-ghost" id="prev-step">← Back</button>` : ""}
      </div>
    `;

    if (step.action === "edit-yaml") {
      this.yamlEditor.refresh();
      this.stepEl.querySelector("#focus-editor")!.addEventListener("click", () => {
        this.yamlEditor.focus();
      });
      this.stepEl.querySelector("#continue-step")!.addEventListener("click", () => {
        this.advanceStep();
      });
    } else {
      this.stepEl.querySelector("#run-step")!.addEventListener("click", () => {
        const result = this.executeCommand(step.command!);
        this.terminal.echoInput(step.command!);
        this.writeResult(result);
        this.yamlEditor.refresh();
        if (result.exitCode === 0) {
          this.advanceStep();
        }
      });
    }
    this.stepEl.querySelector("#next-step")?.addEventListener("click", () => {
      this.advanceStep();
    });
    this.stepEl.querySelector("#prev-step")?.addEventListener("click", () => {
      this.stepIdx = Math.max(0, this.stepIdx - 1);
      this.renderStep();
    });
  }

  private advanceStep(): void {
    if (!this.activeScenario) return;
    if (this.stepIdx < this.activeScenario.steps.length - 1) {
      this.stepIdx++;
      this.renderStep();
    } else {
      this.stepEl.innerHTML = `
        <div class="step-complete">
          <h3>Scenario complete</h3>
          <p>You've walked through all steps for <strong>${this.activeScenario.title}</strong>.</p>
          <button type="button" class="btn btn-primary" id="pick-another">Pick another scenario</button>
        </div>
      `;
      this.stepEl.querySelector("#pick-another")!.addEventListener("click", () => {
        this.activeScenario = null;
        this.root.querySelector("#scenario-guide")!.hidden = true;
        this.renderScenarios();
      });
    }
  }

  private handleCommand(input: string): void {
    const trimmed = input.trim();
    if (!trimmed) return;

    if (!trimmed.startsWith("forkspace")) {
      if (trimmed === "clear") {
        this.terminal.clear();
        return;
      }
      this.terminal.write([
        {
          kind: "stderr",
          text: `${trimmed}: command not found (this playground only simulates forkspace)`,
        },
      ]);
      return;
    }

    const result = this.executeCommand(trimmed);
    this.writeResult(result);
  }

  private executeCommand(input: string): CommandResult {
    const parsed = parseCliInput(input);
    if (!parsed) {
      return { lines: [{ kind: "stderr", text: "Error: could not parse command" }], exitCode: 1 };
    }

    const result = runCommand(this.sim, parsed);
    this.gui.refresh();
    this.yamlEditor.refresh();
    this.syncGuiFromCommand(parsed.command as CommandName, parsed.args, parsed.options);
    return result;
  }

  private writeResult(result: CommandResult): void {
    this.terminal.write(result.lines);
    if (result.exitCode !== 0) {
      this.terminal.write([{ kind: "stderr", text: `(exit ${result.exitCode})` }]);
    }
  }

  private syncGuiFromCommand(
    command: string,
    args: string[],
    options: Record<string, string | boolean>
  ): void {
    const valid: CommandName[] = ["up", "down", "ls", "env", "check", "init", "prune"];
    if (valid.includes(command as CommandName)) {
      this.gui.setCommand(command as CommandName);
    }
  }
}
