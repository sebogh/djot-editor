<script lang="ts">
  import { onMount } from "svelte";
  import Toolbar from "$lib/components/Toolbar.svelte";
  import Editor from "$lib/components/Editor.svelte";
  import Preview from "$lib/components/Preview.svelte";
  import { app, type Theme } from "$lib/state.svelte";
  import * as auth from "$lib/auth.js";
  import { loadShare } from "$lib/share.js";

  let docText = $state(app.initialDoc);

  function applyTheme(t: Theme) {
    const dark =
      t === "dark" ||
      (t === "system" &&
        window.matchMedia("(prefers-color-scheme: dark)").matches);
    document.documentElement.classList.toggle("dark", dark);
  }

  $effect(() => applyTheme(app.theme));

  onMount(() => {
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => {
      if (app.theme === "system") applyTheme("system");
    };
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  });

  async function applyServerConfig() {
    try {
      const res = await fetch("./api/config");
      if (!res.ok) return;
      const config = await res.json();
      app.shareEnabled = !!config.shareEnabled;
      if (config.auth) {
        app.authConfig = config.auth;
        await auth.initAuth(config);
        const signedIn = await auth.isAuthenticated();
        app.user = signedIn ? await auth.getUser() : null;
      }
    } catch (e) {
      console.error("applyServerConfig failed", e);
    } finally {
      app.authReady = true;
    }
  }

  async function loadFromHash() {
    if (!location.hash) return;
    const params = new URLSearchParams(location.hash.slice(1));
    const id = params.get("s");
    const keyB64 = params.get("k");
    if (!id || !keyB64) return;
    try {
      const plaintext = await loadShare(id, keyB64);
      const { title = "", content = "" } = JSON.parse(plaintext);
      app.linkedToShare = true;
      app.title = title;
      app.editor?.setDoc(content, { fromShare: true });
      docText = content;
    } catch (e) {
      console.error("load shared doc failed", e);
    }
  }

  onMount(() => {
    applyServerConfig();
    loadFromHash();
  });
</script>

<Toolbar />
<main class="flex flex-1 min-h-0">
  <div class="flex-1 min-w-0 overflow-hidden">
    <Editor
      initialDoc={app.initialDoc}
      onDocChange={(t) => (docText = t)}
    />
  </div>
  {#if app.previewVisible}
    <div class="flex-1 min-w-0 overflow-auto border-l px-6 py-3">
      <Preview text={docText} />
    </div>
  {/if}
</main>
