import { Text } from "@oh-my-pi/pi-tui";
import type { ExtensionUIContext, ExtensionWidgetContent } from "@oh-my-pi/pi-coding-agent";
import type { Theme } from "@oh-my-pi/pi-tui/theme";

export function feedbackPreview(lines: readonly string[], width: number, theme: Theme, expanded: boolean): readonly string[] {
  if (lines.length <= 6) return lines;
  const hint = expanded ? "Ctrl+O collapse" : `${lines.length - 6} more lines · Ctrl+O expand`;
  return [...(expanded ? lines : lines.slice(0, 6)), ...new Text(theme.fg("dim", hint), 0, 0).render(width)];
}

/** Follow the same expansion state as transcript tools; never replace OMP's Ctrl+O handler. */
export function feedbackWidget(ui: ExtensionUIContext, widget: ExtensionWidgetContent): ExtensionWidgetContent {
  if (typeof widget !== "function") return widget;
  return (tui, theme) => {
    const component = widget(tui, theme);
    return {
      render(width: number) { return feedbackPreview(component.render(width), width, theme, ui.getToolsExpanded()); },
      invalidate() { component.invalidate?.(); },
    };
  };
}
