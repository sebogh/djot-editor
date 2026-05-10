<script lang="ts">
  import { onMount, onDestroy } from "svelte";
  import { Annotation, Compartment, EditorState } from "@codemirror/state";
  import { drawSelection, EditorView, keymap } from "@codemirror/view";
  import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
  import { searchKeymap } from "@codemirror/search";
  import { djotHighlight } from "$lib/djot-highlight.js";
  import { app, saveStorage, STORAGE_DOC } from "$lib/state.svelte";

  type Props = {
    initialDoc: string;
    onDocChange?: (text: string, fromShare: boolean) => void;
  };
  let { initialDoc, onDocChange }: Props = $props();

  let container: HTMLDivElement;
  let view: EditorView | undefined;
  const FromShareLoad = Annotation.define<boolean>();
  const wrapCompartment = new Compartment();
  let docSaveTimer: ReturnType<typeof setTimeout> | null = null;

  function debouncedPersist(text: string) {
    if (docSaveTimer) clearTimeout(docSaveTimer);
    docSaveTimer = setTimeout(() => saveStorage(STORAGE_DOC, text), 300);
  }

  onMount(() => {
    view = new EditorView({
      parent: container,
      state: EditorState.create({
        doc: initialDoc,
        extensions: [
          history(),
          drawSelection(),
          djotHighlight,
          wrapCompartment.of(app.wrapEnabled ? EditorView.lineWrapping : []),
          keymap.of([...defaultKeymap, ...historyKeymap, ...searchKeymap]),
          EditorView.updateListener.of((update) => {
            if (!update.docChanged) return;
            const text = update.state.doc.toString();
            const fromShare = update.transactions.some((tr) =>
              tr.annotation(FromShareLoad),
            );
            onDocChange?.(text, fromShare);
            if (fromShare) return;
            if (app.linkedToShare) {
              app.forkFromShare();
              saveStorage(STORAGE_DOC, text);
              return;
            }
            debouncedPersist(text);
          }),
        ],
      }),
    });
    view.focus();
    const v = view;
    app.setEditor({
      getDoc: () => v.state.doc.toString(),
      setDoc: (text, opts) => {
        v.dispatch({
          changes: { from: 0, to: v.state.doc.length, insert: text },
          annotations: opts?.fromShare ? FromShareLoad.of(true) : undefined,
        });
      },
      focus: () => v.focus(),
      setLineWrap: (enabled) => {
        v.dispatch({
          effects: wrapCompartment.reconfigure(
            enabled ? EditorView.lineWrapping : [],
          ),
        });
      },
      requestMeasure: () => v.requestMeasure(),
    });
  });

  onDestroy(() => {
    if (docSaveTimer) clearTimeout(docSaveTimer);
    view?.destroy();
  });
</script>

<div bind:this={container} class="h-full overflow-hidden"></div>
