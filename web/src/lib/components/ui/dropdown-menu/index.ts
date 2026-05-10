import { DropdownMenu as DropdownMenuPrimitive } from "bits-ui";
import Root from "./dropdown-menu.svelte";
import Content from "./dropdown-menu-content.svelte";
import Item from "./dropdown-menu-item.svelte";
import Separator from "./dropdown-menu-separator.svelte";
import Label from "./dropdown-menu-label.svelte";

const Trigger = DropdownMenuPrimitive.Trigger;
const Group = DropdownMenuPrimitive.Group;
const Portal = DropdownMenuPrimitive.Portal;
const RadioGroup = DropdownMenuPrimitive.RadioGroup;

export {
  Root,
  Content,
  Item,
  Separator,
  Label,
  Trigger,
  Group,
  Portal,
  RadioGroup,
  //
  Root as DropdownMenu,
  Content as DropdownMenuContent,
  Item as DropdownMenuItem,
  Separator as DropdownMenuSeparator,
  Label as DropdownMenuLabel,
  Trigger as DropdownMenuTrigger,
  Group as DropdownMenuGroup,
  Portal as DropdownMenuPortal,
  RadioGroup as DropdownMenuRadioGroup,
};
