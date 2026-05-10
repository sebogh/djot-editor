<script lang="ts">
  import type { HTMLInputAttributes, HTMLInputTypeAttribute } from "svelte/elements";
  import type { WithElementRef } from "bits-ui";
  import { cn } from "$lib/utils.js";

  type InputProps = WithElementRef<
    Omit<HTMLInputAttributes, "type"> & { type?: HTMLInputTypeAttribute }
  >;

  let {
    ref = $bindable(null),
    value = $bindable(),
    type = "text",
    class: className,
    ...restProps
  }: InputProps = $props();
</script>

<input
  bind:this={ref}
  bind:value
  {type}
  class={cn(
    "border-input bg-background placeholder:text-muted-foreground selection:bg-primary selection:text-primary-foreground flex h-9 w-full min-w-0 rounded-md border px-3 py-1 text-sm shadow-xs outline-none transition-[color,box-shadow] file:inline-flex file:h-7 file:border-0 file:bg-transparent file:text-sm file:font-medium disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50 focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px] aria-invalid:ring-destructive/20 aria-invalid:border-destructive",
    className,
  )}
  {...restProps}
/>
