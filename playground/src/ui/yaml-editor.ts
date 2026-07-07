import type { Simulator } from "./engine";
import { checkConfig, parseConfigYaml } from "../sim/parse-config";

export type YamlEditorListener = () => void;

export class YamlEditor {
  private container: HTMLElement;
  private textarea!: HTMLTextAreaElement;
  private statusEl!: HTMLElement;
  private onChange: YamlEditorListener;
  private visible = false;

  constructor(
    container: HTMLElement,
    private sim: Simulator,
    onChange: YamlEditorListener
  ) {
    this.container = container;
    this.onChange = onChange;
    this.render();
  }

  refresh(): void {
    const show = this.sim.hasConfigFile && this.sim.configYaml != null;
    if (show !== this.visible) {
      this.visible = show;
      this.container.hidden = !show;
    }
    if (show && this.sim.configYaml != null && this.textarea.value !== this.sim.configYaml) {
      this.textarea.value = this.sim.configYaml;
      this.setStatus("ok", "forkspace.yml");
    }
    if (!show) {
      this.textarea.value = "";
      this.setStatus("hidden", "");
    }
  }

  focus(): void {
    this.textarea.focus();
  }

  private render(): void {
    this.container.className = "yaml-editor";
    this.container.hidden = true;
    this.container.innerHTML = `
      <div class="yaml-header">
        <h3>forkspace.yml</h3>
        <span class="yaml-status"></span>
      </div>
      <p class="yaml-hint">Edit your workspace config. Changes apply on blur or ⌘/Ctrl+Enter.</p>
      <textarea class="yaml-textarea" spellcheck="false"></textarea>
    `;
    this.textarea = this.container.querySelector(".yaml-textarea")!;
    this.statusEl = this.container.querySelector(".yaml-status")!;

    this.textarea.addEventListener("blur", () => this.apply());
    this.textarea.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        this.apply();
      }
    });
  }

  private apply(): void {
    const raw = this.textarea.value;
    this.sim.configYaml = raw;

    const parsed = parseConfigYaml(raw);
    if (!parsed.ok) {
      this.setStatus("error", "Invalid YAML");
      return;
    }

    this.sim.config = parsed.config;
    const { errors, warnings } = checkConfig(parsed.config);
    if (errors.length > 0) {
      this.setStatus("error", `${errors.length} error${errors.length === 1 ? "" : "s"}`);
      return;
    }

    this.setStatus(
      warnings.length > 0 ? "warn" : "ok",
      warnings.length > 0 ? `${warnings.length} warning${warnings.length === 1 ? "" : "s"}` : "valid"
    );
    this.onChange();
  }

  private setStatus(kind: "ok" | "warn" | "error" | "hidden", text: string): void {
    this.statusEl.className = `yaml-status status-${kind}`;
    this.statusEl.textContent = text;
  }
}
