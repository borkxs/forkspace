import type { Simulator } from "../sim/engine";
import { buildCliCommand, parseCliInput, runCommand } from "../sim/engine";
import type { Config, InstanceRecord } from "../sim/types";

export type CommandName = "up" | "down" | "ls" | "env" | "check" | "init" | "prune";

export interface GuiCommand {
  name: CommandName;
  label: string;
  description: string;
  fields: GuiField[];
}

export interface GuiField {
  key: string;
  label: string;
  type: "text" | "select" | "checkbox" | "multiselect";
  placeholder?: string;
  options?: { value: string; label: string }[];
  required?: boolean;
  showWhen?: (values: Record<string, string | boolean>) => boolean;
}

export const GUI_COMMANDS: GuiCommand[] = [
  {
    name: "up",
    label: "up",
    description: "Start an environment (optionally as an isolated fork)",
    fields: [
      {
        key: "env",
        label: "Environment",
        type: "select",
        required: true,
        options: [],
      },
      {
        key: "fork",
        label: "Fork name",
        type: "text",
        placeholder: "agent-a, migrate-x, …",
      },
      {
        key: "isolate",
        label: "Isolate services",
        type: "multiselect",
        options: [],
        showWhen: (v) => !!v.fork,
      },
      { key: "hooks", label: "Run lifecycle hooks", type: "checkbox" },
      { key: "no-rollback", label: "No rollback on failure", type: "checkbox" },
    ],
  },
  {
    name: "down",
    label: "down",
    description: "Stop an instance (drops volumes unless persistent)",
    fields: [
      {
        key: "env",
        label: "Environment",
        type: "select",
        required: true,
        options: [],
      },
      { key: "fork", label: "Fork name", type: "text", placeholder: "(baseline if empty)" },
      { key: "keep-volumes", label: "Keep volumes", type: "checkbox" },
      { key: "force", label: "Force (skip forkDestroy)", type: "checkbox" },
    ],
  },
  {
    name: "ls",
    label: "ls",
    description: "List instances, slots, namespaces, and ports",
    fields: [
      { key: "ps", label: "Show container status (--ps)", type: "checkbox" },
      { key: "orphans", label: "Orphan audit (--orphans)", type: "checkbox" },
    ],
  },
  {
    name: "env",
    label: "env",
    description: "Print the instance env file (pipe into source)",
    fields: [
      {
        key: "env",
        label: "Environment",
        type: "select",
        required: true,
        options: [],
      },
      { key: "fork", label: "Fork name", type: "text", placeholder: "(baseline if empty)" },
    ],
  },
  {
    name: "check",
    label: "check",
    description: "Validate forkspace.yml against the workspace",
    fields: [],
  },
  {
    name: "init",
    label: "init",
    description: "Write a starter forkspace.yml",
    fields: [],
  },
  {
    name: "prune",
    label: "prune",
    description: "Remove stranded docker projects and workspace artifacts",
    fields: [
      { key: "dry-run", label: "Dry run", type: "checkbox" },
      { key: "force", label: "Force (drop unknown volumes)", type: "checkbox" },
    ],
  },
];

export type GuiRunHandler = (cliCommand: string) => void;

export class GuiPanel {
  private container: HTMLElement;
  private onRun: GuiRunHandler;
  private activeCommand: CommandName = "up";
  private values: Record<string, string | boolean> = { hooks: true };
  private previewEl!: HTMLElement;
  private formEl!: HTMLElement;
  private stateEl!: HTMLElement;
  private sim: Simulator;

  constructor(container: HTMLElement, sim: Simulator, onRun: GuiRunHandler) {
    this.container = container;
    this.sim = sim;
    this.onRun = onRun;
    this.render();
  }

  refresh(): void {
    this.renderState();
    this.renderForm();
    this.updatePreview();
  }

  setCommand(name: CommandName): void {
    this.activeCommand = name;
    this.values = name === "up" ? { hooks: true } : {};
    this.renderTabs();
    this.renderForm();
    this.updatePreview();
  }

  private render(): void {
    this.container.className = "gui-panel";
    this.container.innerHTML = `
      <div class="gui-header">
        <h2>Command panel</h2>
        <p class="gui-sub">Every CLI flag as a form control</p>
      </div>
      <div class="gui-tabs"></div>
      <div class="gui-form"></div>
      <div class="gui-preview">
        <label>CLI equivalent</label>
        <code class="preview-cmd"></code>
        <button type="button" class="btn btn-primary run-btn">Run command</button>
      </div>
      <div class="gui-state">
        <h3>Live state</h3>
        <div class="state-content"></div>
      </div>
    `;
    this.formEl = this.container.querySelector(".gui-form")!;
    this.previewEl = this.container.querySelector(".preview-cmd")!;
    this.stateEl = this.container.querySelector(".state-content")!;
    this.container.querySelector(".run-btn")!.addEventListener("click", () => {
      this.onRun(this.buildCommand());
    });
    this.renderTabs();
    this.renderForm();
    this.renderState();
    this.updatePreview();
  }

  private renderTabs(): void {
    const tabs = this.container.querySelector(".gui-tabs")!;
    tabs.innerHTML = GUI_COMMANDS.map(
      (c) =>
        `<button type="button" class="gui-tab ${c.name === this.activeCommand ? "active" : ""}" data-cmd="${c.name}">${c.label}</button>`
    ).join("");
    tabs.querySelectorAll(".gui-tab").forEach((btn) => {
      btn.addEventListener("click", () => {
        this.setCommand((btn as HTMLElement).dataset.cmd as CommandName);
      });
    });
  }

  private getEnvOptions(): { value: string; label: string }[] {
    return Object.entries(this.sim.config.environments).map(([name, env]) => ({
      value: name,
      label: `${name}${env.persistent ? " (persistent)" : ""}`,
    }));
  }

  private getServiceOptions(envName: string): { value: string; label: string }[] {
    const env = this.sim.config.environments[envName];
    if (!env) return [];
    return Object.entries(env.services).map(([name, svc]) => ({
      value: name,
      label: `${name} (${svc.isolation ?? "container"})`,
    }));
  }

  private renderForm(): void {
    const cmd = GUI_COMMANDS.find((c) => c.name === this.activeCommand)!;
    const envName = (this.values.env as string) || Object.keys(this.sim.config.environments)[0] || "test";

    let html = `<p class="cmd-desc">${cmd.description}</p>`;
    for (const field of cmd.fields) {
      if (field.showWhen && !field.showWhen(this.values)) continue;

      const id = `field-${field.key}`;
      html += `<div class="field">`;
      html += `<label for="${id}">${field.label}</label>`;

      if (field.type === "select") {
        const opts =
          field.key === "env" ? this.getEnvOptions() : (field.options ?? []);
        html += `<select id="${id}" data-key="${field.key}">`;
        for (const o of opts) {
          const sel = this.values[field.key] === o.value ? " selected" : "";
          html += `<option value="${o.value}"${sel}>${o.label}</option>`;
        }
        html += `</select>`;
      } else if (field.type === "multiselect") {
        const opts = this.getServiceOptions(envName);
        const current = ((this.values[field.key] as string) || "").split(",").filter(Boolean);
        html += `<div class="multiselect" data-key="${field.key}">`;
        for (const o of opts) {
          const checked = current.includes(o.value) ? " checked" : "";
          html += `<label class="check-item"><input type="checkbox" value="${o.value}"${checked} /> ${o.label}</label>`;
        }
        html += `</div>`;
      } else if (field.type === "checkbox") {
        const checked = this.values[field.key] !== false ? " checked" : "";
        const negated = field.key === "hooks" || field.key === "no-rollback";
        const isChecked =
          field.key === "hooks"
            ? this.values.hooks !== false
            : this.values[field.key] === true;
        html += `<label class="check-item"><input type="checkbox" id="${id}" data-key="${field.key}"${isChecked ? " checked" : ""} /> ${field.label}</label>`;
        void negated;
        void checked;
      } else {
        html += `<input type="text" id="${id}" data-key="${field.key}" placeholder="${field.placeholder ?? ""}" value="${escapeAttr(String(this.values[field.key] ?? ""))}" />`;
      }
      html += `</div>`;
    }
    this.formEl.innerHTML = html;

    this.formEl.querySelectorAll("select, input[type=text]").forEach((el) => {
      el.addEventListener("change", () => this.syncFromForm());
      el.addEventListener("input", () => this.syncFromForm());
    });
    this.formEl.querySelectorAll("input[type=checkbox]").forEach((el) => {
      el.addEventListener("change", () => this.syncFromForm());
    });

    if (!this.values.env && cmd.fields.some((f) => f.key === "env")) {
      this.values.env = envName;
    }
  }

  private syncFromForm(): void {
    const cmd = GUI_COMMANDS.find((c) => c.name === this.activeCommand)!;
    for (const field of cmd.fields) {
      if (field.type === "multiselect") {
        const box = this.formEl.querySelector(`[data-key="${field.key}"]`);
        if (box) {
          const checked = [...box.querySelectorAll<HTMLInputElement>("input:checked")].map(
            (i) => i.value
          );
          this.values[field.key] = checked.join(",");
        }
      } else if (field.type === "checkbox") {
        const el = this.formEl.querySelector<HTMLInputElement>(`[data-key="${field.key}"]`);
        if (el) {
          if (field.key === "hooks") {
            this.values.hooks = el.checked;
          } else {
            this.values[field.key] = el.checked;
          }
        }
      } else {
        const el = this.formEl.querySelector<HTMLInputElement | HTMLSelectElement>(
          `[data-key="${field.key}"]`
        );
        if (el) this.values[field.key] = el.value;
      }
    }
    if (this.activeCommand === "up" && this.values.fork) {
      this.renderForm();
    }
    this.updatePreview();
  }

  private buildCommand(): string {
    const cmd = this.activeCommand;
    const opts: Record<string, string | boolean | undefined> = {};

    if (cmd === "up") {
      const env = this.values.env as string;
      let s = `forkspace up ${env}`;
      if (this.values.fork) s += ` --fork ${this.values.fork}`;
      if (this.values.isolate) s += ` --isolate ${this.values.isolate}`;
      if (this.values.hooks === false) s += " --no-hooks";
      if (this.values["no-rollback"]) s += " --no-rollback";
      return s;
    }
    if (cmd === "down") {
      const env = this.values.env as string;
      if (this.values.fork) opts.fork = this.values.fork as string;
      if (this.values["keep-volumes"]) opts["keep-volumes"] = true;
      if (this.values.force) opts.force = true;
      return `forkspace down ${env}${formatOpts(opts)}`;
    }
    if (cmd === "ls") {
      if (this.values.ps) opts.ps = true;
      if (this.values.orphans) opts.orphans = true;
      return `forkspace ls${formatOpts(opts)}`;
    }
    if (cmd === "env") {
      const env = this.values.env as string;
      if (this.values.fork) opts.fork = this.values.fork as string;
      return `forkspace env ${env}${formatOpts(opts)}`;
    }
    if (cmd === "prune") {
      if (this.values["dry-run"]) opts["dry-run"] = true;
      if (this.values.force) opts.force = true;
      return `forkspace prune${formatOpts(opts)}`;
    }
    return `forkspace ${cmd}`;
  }

  private updatePreview(): void {
    this.previewEl.textContent = this.buildCommand();
  }

  private renderState(): void {
    const instances = Object.values(this.sim.state.instances);
    if (instances.length === 0) {
      this.stateEl.innerHTML = `<p class="state-empty">No instances running</p>`;
      return;
    }
    this.stateEl.innerHTML = instances
      .map((inst) => renderInstanceCard(inst, this.sim.config))
      .join("");
  }
}

function formatOpts(opts: Record<string, string | boolean | undefined>): string {
  let s = "";
  for (const [k, v] of Object.entries(opts)) {
    if (!v) continue;
    if (v === true) s += ` --${k}`;
    else s += ` --${k} ${v}`;
  }
  return s;
}

function renderInstanceCard(inst: InstanceRecord, config: Config): string {
  const ports = Object.entries(inst.ports)
    .filter(([n]) => inst.services.includes(n) || config.environments[inst.env]?.allocations?.[n])
    .map(([n, p]) => `<span class="port-chip">${n}:${p}</span>`)
    .join("");

  return `
    <div class="instance-card ${inst.fork ? "fork" : "baseline"}">
      <div class="instance-header">
        <span class="instance-key">${inst.key}</span>
        <span class="instance-slot">slot ${inst.slot}</span>
      </div>
      <div class="instance-meta">
        <span>${inst.backing}</span>
        ${inst.ns ? `<span>ns=${inst.ns}</span>` : ""}
      </div>
      <div class="instance-ports">${ports}</div>
    </div>
  `;
}

function escapeAttr(s: string): string {
  return s.replace(/"/g, "&quot;");
}
