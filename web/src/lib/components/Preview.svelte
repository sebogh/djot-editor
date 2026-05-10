<script lang="ts">
  import { parse, renderHTML } from "@djot/djot";
  import DOMPurify from "dompurify";

  type Props = { text: string };
  let { text }: Props = $props();

  let html = $state("");

  $effect(() => {
    try {
      html = DOMPurify.sanitize(renderHTML(parse(text)));
    } catch {
      /* keep previous render on transient parse errors */
    }
  });
</script>

<div class="preview-prose">{@html html}</div>
