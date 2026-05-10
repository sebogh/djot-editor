<script lang="ts">
  import type { HTMLButtonAttributes } from "svelte/elements";
  import type { WithElementRef } from "bits-ui";
  import { cn } from "$lib/utils.js";

  type Props = WithElementRef<HTMLButtonAttributes> & {
    pressed: boolean;
    onPressedChange?: (next: boolean) => void;
  };

  let {
    ref = $bindable(null),
    class: className,
    pressed,
    onPressedChange,
    children,
    onclick,
    ...restProps
  }: Props = $props();

  function handleClick(e: MouseEvent) {
    onPressedChange?.(!pressed);
    onclick?.(e as MouseEvent & { currentTarget: EventTarget & HTMLButtonElement });
  }
</script>

<button
  bind:this={ref}
  type="button"
  aria-pressed={pressed}
  data-state={pressed ? "on" : "off"}
  onclick={handleClick}
  class={cn(
    "focus-visible:border-ring focus-visible:ring-ring/50 inline-flex h-8 cursor-pointer items-center justify-center gap-1.5 rounded-md px-2.5 text-xs font-medium outline-none transition-all focus-visible:ring-[3px] disabled:pointer-events-none disabled:opacity-50",
    "border bg-background hover:bg-accent hover:text-accent-foreground",
    "data-[state=on]:bg-accent data-[state=on]:text-accent-foreground data-[state=on]:border-foreground/20",
    "[&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-3.5",
    className,
  )}
  {...restProps}
>
  {@render children?.()}
</button>
