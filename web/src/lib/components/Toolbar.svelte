<script lang="ts">
  import { Input } from "$lib/components/ui/input";
  import { Button } from "$lib/components/ui/button";
  import { ToggleButton } from "$lib/components/ui/toggle-button";
  import ThemeMenu from "./ThemeMenu.svelte";
  import AuthMenu from "./AuthMenu.svelte";
  import WrapText from "lucide-svelte/icons/wrap-text";
  import PanelRight from "lucide-svelte/icons/panel-right";
  import Share2 from "lucide-svelte/icons/share-2";
  import Download from "lucide-svelte/icons/download";
  import Eraser from "lucide-svelte/icons/eraser";
  import { app } from "$lib/state.svelte";
  import { createShare } from "$lib/share.js";

  let shareLabel = $state<"Share" | "Sharing…" | "Copied!" | "Failed">("Share");
  let shareBusy = $state(false);

  function sanitizeFilename(title: string): string {
    const cleaned = (title || "")
      .trim()
      .replace(/\s+/g, "-")
      .replace(/[\\/:*?"<>|]/g, "")
      .replace(/^-+|-+$/g, "");
    return cleaned || "untitled";
  }

  function downloadDoc() {
    const text = app.editor?.getDoc() ?? "";
    const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${sanitizeFilename(app.title)}.dj`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  async function shareDoc() {
    if (shareBusy || !app.shareEnabled) return;
    shareBusy = true;
    shareLabel = "Sharing…";
    try {
      const payload = JSON.stringify({
        title: app.title,
        content: app.editor?.getDoc() ?? "",
      });
      const { id, keyB64 } = await createShare(payload);
      const url = new URL(location.href);
      url.hash = `s=${id}&k=${keyB64}`;
      history.replaceState(null, "", url.toString());
      app.linkedToShare = true;
      await navigator.clipboard.writeText(url.toString());
      shareLabel = "Copied!";
    } catch (e) {
      console.error("share failed", e);
      shareLabel = "Failed";
    } finally {
      setTimeout(() => {
        shareLabel = "Share";
        shareBusy = false;
      }, 1500);
    }
  }

  function setWrap(next: boolean) {
    app.wrapEnabled = next;
    app.editor?.setLineWrap(next);
  }

  function setPreview(next: boolean) {
    app.previewVisible = next;
    queueMicrotask(() => app.editor?.requestMeasure());
  }
</script>

<header
  class="flex flex-none items-center gap-3 border-b bg-background px-3 py-2"
>
  <Input
    type="text"
    placeholder="Untitled"
    aria-label="Document title"
    class="h-8 max-w-xs border-transparent bg-transparent text-base font-semibold shadow-none hover:border-border focus-visible:border-input"
    value={app.title}
    oninput={(e) => app.setTitle(e.currentTarget.value)}
  />

  <div class="ml-auto flex items-center gap-2">
    <ToggleButton
      pressed={app.wrapEnabled}
      onPressedChange={setWrap}
      aria-label="Toggle line wrap"
      title="Wrap lines"
    >
      <WrapText />
      <span class="hidden sm:inline">Wrap</span>
    </ToggleButton>
    <ToggleButton
      pressed={app.previewVisible}
      onPressedChange={setPreview}
      aria-label="Toggle preview pane"
      title="Show preview"
    >
      <PanelRight />
      <span class="hidden sm:inline">Preview</span>
    </ToggleButton>

    <div class="bg-border mx-1 h-5 w-px"></div>

    <Button
      variant="outline"
      size="sm"
      onclick={shareDoc}
      disabled={shareBusy || !app.shareEnabled}
      title={app.shareEnabled
        ? "Encrypt and copy a share link"
        : "Sharing is disabled on this server"}
    >
      <Share2 />
      {shareLabel}
    </Button>
    <Button variant="outline" size="sm" onclick={downloadDoc} title="Download .dj">
      <Download />
      <span class="hidden md:inline">Download</span>
    </Button>
    <Button
      variant="ghost"
      size="sm"
      onclick={() => app.clear()}
      title="Clear document"
    >
      <Eraser />
      <span class="hidden md:inline">Clear</span>
    </Button>

    <div class="bg-border mx-1 h-5 w-px"></div>

    <ThemeMenu />
    <AuthMenu />
  </div>
</header>
