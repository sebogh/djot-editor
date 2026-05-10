<script lang="ts" module>
  import type { WithoutChildrenOrChild } from "bits-ui";
  import { DropdownMenu as DropdownMenuPrimitive } from "bits-ui";

  export type DropdownMenuLabelProps = WithoutChildrenOrChild<DropdownMenuPrimitive.GroupHeadingProps> & {
    inset?: boolean;
    children?: import("svelte").Snippet;
  };
</script>

<script lang="ts">
  import { cn } from "$lib/utils.js";

  let {
    ref = $bindable(null),
    class: className,
    inset = false,
    children,
    ...restProps
  }: DropdownMenuLabelProps = $props();
</script>

<DropdownMenuPrimitive.GroupHeading
  bind:ref
  data-inset={inset ? "" : undefined}
  class={cn("px-2 py-1.5 text-sm font-medium data-[inset]:pl-8", className)}
  {...restProps}
>
  {@render children?.()}
</DropdownMenuPrimitive.GroupHeading>
