import { Injectable, NgZone } from '@angular/core';
import { Card } from '@udonarium/card';
import { CardStack } from '@udonarium/card-stack';
import { ChatTabList } from '@udonarium/chat-tab-list';
import {
  CharacterClipboardData,
  createGameCharacterFromCcfolia,
  tryParseCcfoliaCharacter,
} from '@udonarium/ccfolia-clipboard';
import { ObjectNode } from '@udonarium/core/synchronize-object/object-node';
import { ObjectSerializer } from '@udonarium/core/synchronize-object/object-serializer';
import { ObjectStore } from '@udonarium/core/synchronize-object/object-store';
import { EventSystem, Network } from '@udonarium/core/system';
import { DiceSymbol } from '@udonarium/dice-symbol';
import { CharacterToken } from '@udonarium/character-token';
import { GameCharacter } from '@udonarium/game-character';
import { GameTableMask } from '@udonarium/game-table-mask';
import { PeerCursor } from '@udonarium/peer-cursor';
import { RangeArea } from '@udonarium/range';
import { PresetSound, SoundEffect } from '@udonarium/sound-effect';
import { TableDrawing } from '@udonarium/table-fx/table-drawing';
import { TableLight } from '@udonarium/table-fx/table-light';
import { TableWall } from '@udonarium/table-fx/table-wall';
import { TableSelecter } from '@udonarium/table-selecter';
import { TabletopObject } from '@udonarium/tabletop-object';
import { moveToBackmost, moveToTopmost, reconcileLayerStack, Stackable } from '@udonarium/tabletop-object-util';
import { Terrain } from '@udonarium/terrain';
import { terrainsInBakeGroup } from '@udonarium/terrain-model/bake-group';
import { TextNote } from '@udonarium/text-note';
import { MovableDirective } from 'directive/movable.directive';
import { MovableSelectionSynchronizer } from 'directive/movable-selection-synchronizer';
import { RotableSelectionSynchronizer } from 'directive/rotable-selection-synchronizer';

import { CoordinateService } from './coordinate.service';
import { ContextMenuService } from './context-menu.service';
import { I18nService } from './i18n.service';
import { ModalService } from './modal.service';
import { PanelService } from './panel.service';
import { PointerDeviceService, PointerCoordinate } from './pointer-device.service';
import { SceneToolService } from './scene-tool.service';
import { filesFromDataTransfer, TabletopFileDropService } from './tabletop-file-drop.service';
import { SelectionState, TabletopSelectionService } from './tabletop-selection.service';
import { TokenPathMoveService } from './token-path-move.service';
import { DeleteEntry, UndoService } from './undo.service';
import { findCardOrStackIdAtPoint } from 'component/card-stack/card-stack-gesture';

const MOVE_CODES = new Set([
  'KeyW', 'KeyA', 'KeyS', 'KeyD',
  'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
]);

const ALTITUDE_MIN = -12;
const ALTITUDE_MAX = 12;

@Injectable({
  providedIn: 'root'
})
export class TabletopKeyboardService {
  private readonly pressed = new Set<string>();
  private clipboardXml: string[] = [];
  /** Source ids parallel to clipboardXml (for TextNote cross-map shared paste). */
  private clipboardSourceIds: string[] = [];
  /** Set when Ctrl+Shift+V is handled on keydown so the following paste event is ignored. */
  private ignoreNextPaste = false;
  private listening = false;
  /** Acc for Alt/Ctrl+Shift wheel → one discrete step per notch. */
  private wheelAcc = 0;
  /**
   * Track Alt from keydown/keyup only — do not trust e.altKey after Alt+wheel.
   * Windows/Chrome can leave altKey sticky or steal focus to the menu bar.
   */
  private altHeld = false;
  /** Last pointer context for Ctrl+A (inventory vs map vs other panels). */
  private interactionContext: 'inventory' | 'map' | 'other' = 'map';
  /** rAF id while WASD/arrows are held — continuous move + live shadows (like drag). */
  private moveLoopRaf = 0;
  private moveLoopLastTs = 0;
  /** rAF id while finishing a short tap to the next grid cell. */
  private tapGlideRaf = 0;
  private moveSessionStartMs = 0;
  private moveSessionStartPos = new Map<string, { x: number; y: number }>();
  private moveSessionLastDir: { dx: number; dy: number } | null = null;
  /** Guard against keyup + rAF both finishing the same session. */
  private moveReleaseHandled = true;
  private static readonly MOVE_CELLS_PER_SEC = 5.5;
  /** Short press → glide the remainder of one grid cell (drag-like). */
  private static readonly TAP_COMPLETE_MS = 280;
  private static readonly TAP_GLIDE_MS = 150;

  private readonly onKeyDown = (e: KeyboardEvent) => this.handleKeyDown(e);
  private readonly onKeyUp = (e: KeyboardEvent) => this.handleKeyUp(e);
  private readonly onWheel = (e: WheelEvent) => this.handleWheel(e);
  private readonly onPointerDown = (e: PointerEvent) => this.handlePointerDown(e);
  private readonly onPaste = (e: ClipboardEvent) => this.handlePaste(e);
  private readonly onBlur = () => {
    this.pressed.clear();
    this.wheelAcc = 0;
    this.altHeld = false;
    this.selectionService.setCanvasHighlight(false);
    this.cancelTapGlide();
    this.stopContinuousMoveLoop(true);
  };

  constructor(
    private selectionService: TabletopSelectionService,
    private coordinateService: CoordinateService,
    private pointerDevice: PointerDeviceService,
    private sceneTools: SceneToolService,
    private undoService: UndoService,
    private tokenPath: TokenPathMoveService,
    private contextMenu: ContextMenuService,
    private tabletopFileDrop: TabletopFileDropService,
    private i18n: I18nService,
    private ngZone: NgZone,
  ) { }

  /**
   * Objects that receive tabletop shortcuts.
   * Explicit selection wins; otherwise the card / card-stack under the pointer (hover).
   */
  private shortcutTargets(): TabletopObject[] {
    if (this.selectionService.size > 0) return this.selectionService.objects;
    const hovered = this.resolveHoveredCardOrStack();
    return hovered ? [hovered] : [];
  }

  /** F / R (cards): only the card or stack under the pointer — never box-selection alone. */
  private hoverCardOrStackTargets(): TabletopObject[] {
    const hovered = this.resolveHoveredCardOrStack();
    return hovered ? [hovered] : [];
  }

  /** Card or stack under the current pointer (page → client for hit-test). */
  private resolveHoveredCardOrStack(): Card | CardStack | null {
    const ptr = this.pointerDevice.pointers[0];
    if (!ptr) return null;
    const clientX = ptr.x - (window.scrollX || window.pageXOffset || 0);
    const clientY = ptr.y - (window.scrollY || window.pageYOffset || 0);
    const id = findCardOrStackIdAtPoint(clientX, clientY);
    if (!id) return null;
    const obj = ObjectStore.instance.get(id);
    if (obj instanceof CardStack || obj instanceof Card) return obj;
    return null;
  }

  /** R (dice): selected dice, else dice under the pointer. */
  private diceRollTargets(): DiceSymbol[] {
    if (this.selectionService.size > 0) {
      return this.selectionService.objects.filter((o): o is DiceSymbol => o instanceof DiceSymbol);
    }
    const hovered = this.resolveHoveredDice();
    return hovered ? [hovered] : [];
  }

  /** Dice under the current pointer (page → client for hit-test). */
  private resolveHoveredDice(): DiceSymbol | null {
    const ptr = this.pointerDevice.pointers[0];
    if (!ptr || typeof document === 'undefined') return null;
    const clientX = ptr.x - (window.scrollX || window.pageXOffset || 0);
    const clientY = ptr.y - (window.scrollY || window.pageYOffset || 0);
    const hits = document.elementsFromPoint(clientX, clientY);
    for (const el of hits) {
      const host = el.closest?.('dice-symbol');
      if (!host) continue;
      const id = host.getAttribute('data-stack-id');
      if (!id) continue;
      const obj = ObjectStore.instance.get(id);
      if (obj instanceof DiceSymbol) return obj;
    }
    return null;
  }

  private runInAngular<T>(fn: () => T): T {
    return NgZone.isInAngularZone() ? fn() : this.ngZone.run(fn);
  }

  initialize() {
    if (this.listening) return;
    this.undoService.setPoseVisualSync((object, pose) => {
      MovableDirective.syncPoseFromUndo(object, pose.x, pose.y, pose.posZ);
      if (pose.rotate != null || pose.roll != null) {
        RotableSelectionSynchronizer.syncRotateFromUndo(object, pose);
      }
    });
    document.addEventListener('keydown', this.onKeyDown, true);
    document.addEventListener('keyup', this.onKeyUp, true);
    document.addEventListener('pointerdown', this.onPointerDown, true);
    document.addEventListener('paste', this.onPaste, true);
    document.addEventListener('wheel', this.onWheel, { capture: true, passive: false });
    window.addEventListener('blur', this.onBlur);
    this.listening = true;
  }

  destroy() {
    if (!this.listening) return;
    document.removeEventListener('keydown', this.onKeyDown, true);
    document.removeEventListener('keyup', this.onKeyUp, true);
    document.removeEventListener('pointerdown', this.onPointerDown, true);
    document.removeEventListener('paste', this.onPaste, true);
    document.removeEventListener('wheel', this.onWheel, true);
    window.removeEventListener('blur', this.onBlur);
    this.pressed.clear();
    this.altHeld = false;
    this.selectionService.setCanvasHighlight(false);
    this.cancelTapGlide();
    if (this.moveLoopRaf) {
      cancelAnimationFrame(this.moveLoopRaf);
      this.moveLoopRaf = 0;
    }
    this.finishContinuousMove();
    this.listening = false;
  }

  private handleKeyDown(e: KeyboardEvent) {
    const code = e.code;
    if (code === 'AltLeft' || code === 'AltRight') {
      if (this.shouldIgnore(e)) return;
      this.altHeld = true;
      this.runInAngular(() => this.selectionService.setCanvasHighlight(true));
      // Stop Windows/Chrome from focusing the menu bar (breaks WASD after Alt+wheel).
      if (e.cancelable) e.preventDefault();
      return;
    }

    // Esc: menu/modal → cancel drafts/selection → close frontmost window.
    // Handled before shouldIgnore so a focused chat input does not block clearing selection.
    if (code === 'Escape' && !e.ctrlKey && !e.metaKey && !this.altHeld && !e.shiftKey) {
      this.handleEscape(e);
      return;
    }

    if (this.shouldIgnore(e)) {
      // Note inline editor: keep [ ] as layer shortcuts (blur so we don't type brackets into the note).
      if ((code === 'BracketLeft' || code === 'BracketRight') && this.isTextNoteEditorFocus()) {
        (document.activeElement as HTMLElement | null)?.blur?.();
      } else {
        return;
      }
    }

    if (MOVE_CODES.has(code)) this.pressed.add(code);

    const mod = e.ctrlKey || e.metaKey;

    if (mod && !this.altHeld && !e.shiftKey) {
      if (code === 'KeyZ') {
        if (this.undoService.undo()) this.consume(e);
        return;
      }
      if (code === 'KeyY') {
        if (this.undoService.redo()) this.consume(e);
        return;
      }
      if (code === 'KeyC') {
        if (this.hasTextSelection()) return;
        if (this.copySelection()) this.consume(e);
        return;
      }
      if (code === 'KeyX') {
        if (this.hasTextSelection()) return;
        if (this.cutSelection()) this.consume(e);
        return;
      }
      if (code === 'KeyV') {
        // Paste is handled in handlePaste so OS CCFOLIA JSON can take priority.
        return;
      }
      if (code === 'KeyA') {
        // Outside text fields: never let the browser select the whole page.
        this.handleSelectAll(e);
        return;
      }
    }

    if (mod && e.shiftKey && !this.altHeld && code === 'KeyV') {
      // Ctrl+Shift+V: temporary Token paste — only when clipboard has character/Token.
      if (this.hasTextSelection()) return;
      if (!this.hasCharacterClipboard) return;
      if (this.pasteTemporaryAtPointer()) {
        this.ignoreNextPaste = true;
        this.consume(e);
      }
      return;
    }

    if (mod && e.shiftKey && !this.altHeld && code === 'KeyZ') {
      if (this.undoService.redo()) this.consume(e);
      return;
    }

    // 1–9: switch chat tab (works for guests; blocked in text fields by shouldIgnore).
    if (!mod && !this.altHeld && !e.shiftKey) {
      const tabIndex = this.digitIndexFromCode(code);
      if (tabIndex != null) {
        if (this.selectChatTabByIndex(tabIndex)) this.consume(e);
        return;
      }
    }

    // C: close all closable desktop panels (same as toolbox「清空桌面視窗」).
    // Ctrl/Cmd+C remains copy. Ignored in INPUT/TEXTAREA via shouldIgnore.
    if (!mod && !this.altHeld && !e.shiftKey && code === 'KeyC') {
      PanelService.closeAllPanels();
      this.consume(e);
      return;
    }

    // = / +: enlarge frontmost window, else zoom map in.
    // - : shrink frontmost window, else zoom map out.
    if (!mod && !this.altHeld && (code === 'Equal' || code === 'NumpadAdd' || code === 'Minus' || code === 'NumpadSubtract')) {
      const enlarge = code === 'Equal' || code === 'NumpadAdd';
      if (PanelService.scaleFrontmostPanel(enlarge ? 1.1 : 1 / 1.1)) {
        this.consume(e);
        return;
      }
      EventSystem.trigger('TABLE_VIEW_ZOOM', { deltaZ: enlarge ? 150 : -150 });
      this.consume(e);
      return;
    }

    if (Network.GuestMode()) {
      return;
    }

    // Path draft: Space commits movement along existing waypoints.
    // Else GM toggles room PAUSE watermark (non-blocking).
    if (code === 'Space' && !mod && !this.altHeld && !e.shiftKey) {
      if (this.tokenPath.hasDraft && !this.tokenPath.isAnimating) {
        void this.tokenPath.commit();
        this.consume(e);
      } else if (PeerCursor.myCursor?.isGMMode) {
        TableSelecter.instance.togglePaused();
        this.consume(e);
      }
      // Always stop here so Space does not fall through to WASD / other handlers.
      return;
    }

    if (code === 'Delete' && !mod && !this.altHeld) {
      if (this.sceneTools.selectionCount > 0) {
        if (this.sceneTools.deleteSelection()) this.consume(e);
        return;
      }
      if (this.deleteSelection()) this.consume(e);
      return;
    }

    if ((code === 'BracketLeft' || code === 'BracketRight') && !mod && !this.altHeld && !e.shiftKey) {
      if (Network.GuestMode()) return;
      const changed = this.runInAngular(() => this.changeLayerOrder(code === 'BracketRight'));
      if (changed) this.consume(e);
      return;
    }

    // Q/E: rotate selection (±45°; Shift = ±15°). Empty selection → view yaw in TableMouseGesture.
    if ((code === 'KeyQ' || code === 'KeyE') && !mod && !this.altHeld) {
      if (this.sceneTools.selectionCount > 0) return;
      const targets = this.shortcutTargets();
      if (targets.length < 1) return;
      const step = e.shiftKey ? 15 : 45;
      const delta = code === 'KeyQ' ? -step : step;
      if (RotableSelectionSynchronizer.rotateBy(targets, delta)) {
        this.consume(e);
      }
      return;
    }

    // R: roll selected/hovered dice; else shuffle hovered stack, else reset facing on hovered card.
    if (code === 'KeyR' && !mod && !this.altHeld && !e.shiftKey) {
      if (this.sceneTools.selectionCount > 0) return;
      const dice = this.diceRollTargets();
      if (dice.length > 0) {
        if (this.runInAngular(() => this.rollDiceObjects(dice))) this.consume(e);
        return;
      }
      const objects = this.hoverCardOrStackTargets();
      if (objects.length < 1) return;
      if (objects.every(o => o instanceof CardStack)) {
        let shuffled = false;
        for (const object of objects) {
          if (!(object instanceof CardStack) || object.isLocked || object.isEmpty) continue;
          object.shuffle();
          EventSystem.call('SHUFFLE_CARD_STACK', { identifier: object.identifier });
          shuffled = true;
        }
        if (shuffled) {
          SoundEffect.play(PresetSound.cardShuffle);
          this.consume(e);
        }
        return;
      }
      if (RotableSelectionSynchronizer.resetAngles(objects)) {
        this.consume(e);
      }
      return;
    }

    // PageUp / PageDown: nudge altitude (±1; Shift = ±0.5).
    if ((code === 'PageUp' || code === 'PageDown') && !mod && !this.altHeld) {
      if (this.sceneTools.selectionCount > 0) return;
      if (this.shortcutTargets().length < 1) return;
      const step = e.shiftKey ? 0.5 : 1;
      const delta = code === 'PageUp' ? step : -step;
      if (this.runInAngular(() => this.nudgeAltitude(delta))) this.consume(e);
      return;
    }

    // F: flip hovered card, or turn over hovered deck (inverse). Hover required (not box-select). Dice use R.
    if (code === 'KeyF' && !mod && !this.altHeld && !e.shiftKey) {
      if (this.sceneTools.selectionCount > 0) return;
      const hovered = this.hoverCardOrStackTargets();
      if (hovered.length < 1) return;
      if (this.runInAngular(() => this.flipCardObjects(hovered))) this.consume(e);
      return;
    }

    // H: GM hide / reveal selected characters.
    if (code === 'KeyH' && !mod && !this.altHeld && !e.shiftKey) {
      if (this.sceneTools.selectionCount > 0) return;
      if (this.shortcutTargets().length < 1) return;
      if (this.runInAngular(() => this.toggleHideSelection())) this.consume(e);
      return;
    }

    // L: lock / unlock selected objects.
    if (code === 'KeyL' && !mod && !this.altHeld && !e.shiftKey) {
      if (this.sceneTools.selectionCount > 0) return;
      if (this.shortcutTargets().length < 1) return;
      if (this.runInAngular(() => this.toggleLockSelection())) this.consume(e);
      return;
    }

    // T: congregate selected tokens to the current mouse / pointer position on the table.
    if (code === 'KeyT' && !mod && !this.altHeld && !e.shiftKey) {
      if (this.sceneTools.selectionCount > 0) return;
      if (this.shortcutTargets().length < 1) return;
      if (this.congregateSelectionToPointer()) this.consume(e);
      return;
    }

    if (!MOVE_CODES.has(code) || mod || this.altHeld) return;

    // Scene-tool selection: continuous WASD / arrows (live shadows while lights move).
    if (this.sceneTools.selectionCount > 0) {
      if (e.shiftKey) return;
      if (!this.moveDeltaFromPressed()) return;
      this.beginOrContinueMoveSession([]);
      this.consume(e);
      return;
    }

    const moveTargets = this.shortcutTargets();
    if (moveTargets.length < 1) return;

    if (e.shiftKey) {
      const angle = this.facingAngleFromPressed();
      if (angle == null) return;
      if (RotableSelectionSynchronizer.face(moveTargets, angle)) {
        this.consume(e);
      }
      return;
    }

    if (!this.moveDeltaFromPressed()) return;
    // Drag-like: continuous rAF from the first frame (no instant grid teleport).
    this.beginOrContinueMoveSession(moveTargets);
    this.consume(e);
  }

  private handleKeyUp(e: KeyboardEvent) {
    if (e.code === 'AltLeft' || e.code === 'AltRight') {
      this.altHeld = false;
      this.runInAngular(() => this.selectionService.setCanvasHighlight(false));
      return;
    }
    // Heal lost Alt keyup (common after Alt+wheel on Windows).
    if (!e.altKey) {
      this.altHeld = false;
      this.runInAngular(() => this.selectionService.setCanvasHighlight(false));
    }
    this.pressed.delete(e.code);
    if (MOVE_CODES.has(e.code) && !this.moveDeltaFromPressed()) {
      this.stopContinuousMoveLoop(true);
    }
  }

  private handleWheel(e: WheelEvent) {
    if (this.shouldIgnore(e)) return;
    if (Network.GuestMode()) return;
    // With selection:
    //   Alt+wheel → facing ±3° per notch
    //   Alt+Shift+wheel → roll ±3° per notch
    //   Ctrl+Shift+wheel → facing ±45° per notch
    // Empty selection: Alt / Alt+Shift view rotate (±3°) is handled by TableMouseGesture.
    // Prefer live e.altKey for the gesture; also accept tracked altHeld.
    const alt = e.altKey || this.altHeld;
    const isCtrlShift = (e.ctrlKey || e.metaKey) && e.shiftKey;
    const isAltOnly = alt && !e.ctrlKey && !e.metaKey && !e.shiftKey;
    const isAltShift = alt && e.shiftKey && !e.ctrlKey && !e.metaKey;
    const stepDeg = isCtrlShift ? 45 : (isAltOnly || isAltShift) ? 3 : null;
    if (stepDeg == null) return;
    const wheelTargets = this.shortcutTargets();
    if (wheelTargets.length < 1) return;

    // Prefer the dominant axis (Shift may still contribute deltaX while Ctrl is held).
    const scroll = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
    if (scroll === 0) return;

    let amount = scroll;
    if (e.deltaMode === WheelEvent.DOM_DELTA_LINE) amount *= 16;
    else if (e.deltaMode === WheelEvent.DOM_DELTA_PAGE) amount *= 800;

    // Always consume so TableMouseGesture cannot also rotate the view.
    e.preventDefault();
    e.stopPropagation();

    const notch = 100;
    this.wheelAcc += amount;
    if (Math.abs(this.wheelAcc) < notch) return;
    const dir = this.wheelAcc > 0 ? 1 : -1;
    this.wheelAcc -= dir * notch;
    const delta = dir * stepDeg;

    if (isAltShift) {
      RotableSelectionSynchronizer.rollBy(wheelTargets, delta);
    } else {
      RotableSelectionSynchronizer.rotateBy(wheelTargets, delta);
    }
  }

  private handlePointerDown(e: PointerEvent) {
    const target = e.target;
    if (!(target instanceof Element)) return;
    if (target.closest('game-object-inventory, [data-tour-panel="menu.inventory"]')) {
      this.interactionContext = 'inventory';
      return;
    }
    if (target.closest('game-table')) {
      this.interactionContext = 'map';
      return;
    }
    if (target.closest('.draggable-panel')) {
      this.interactionContext = 'other';
      return;
    }
    // Empty canvas / app chrome → treat as map.
    this.interactionContext = 'map';
  }

  private handleSelectAll(e: KeyboardEvent) {
    const context = this.resolveSelectAllContext(e);
    if (context === 'inventory') {
      EventSystem.trigger('INVENTORY_SELECT_ALL', null);
      this.consume(e);
      return;
    }
    if (context === 'map' && !Network.GuestMode()) {
      this.selectAllMapTokens();
    }
    // Always consume outside text fields so Ctrl+A does not highlight the whole page.
    this.consume(e);
  }

  private resolveSelectAllContext(e: KeyboardEvent): 'inventory' | 'map' | 'other' {
    const target = e.target;
    if (target instanceof Element) {
      if (target.closest('game-object-inventory, [data-tour-panel="menu.inventory"]')) return 'inventory';
      if (target.closest('game-table')) return 'map';
      if (target.closest('.draggable-panel')) return 'other';
    }
    return this.interactionContext;
  }

  private selectAllMapTokens(): boolean {
    this.selectionService.clear();
    const tokens = ObjectStore.instance.getObjects(CharacterToken);
    let count = 0;
    let first: CharacterToken = null;
    const isGM = !!PeerCursor.myCursor?.isGMMode;
    for (const tok of tokens) {
      if (!tok.isVisibleOnTable) continue;
      if (!tok.isVisible && !isGM) continue;
      this.selectionService.add(tok);
      if (!first) first = tok;
      count++;
    }
    if (first) {
      EventSystem.trigger('SELECT_TABLETOP_OBJECT', {
        identifier: first.identifier,
        className: first.aliasName,
        highlighting: true,
      });
      SoundEffect.playLocal(PresetSound.selectionStart);
    }
    return count > 0;
  }

  private shouldIgnore(e: Event): boolean {
    const target = e.target;
    if (!(target instanceof HTMLElement)) return false;
    const tag = target.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
    if (target.isContentEditable) return true;
    return !!target.closest('[contenteditable="true"], [contenteditable=""]');
  }

  /** True when focus is in a tabletop note's inline textarea (not chat / panel fields). */
  private isTextNoteEditorFocus(): boolean {
    const ae = document.activeElement;
    return ae instanceof HTMLTextAreaElement && !!ae.closest('text-note');
  }

  /**
   * Esc priority: context menu → modal → path/scene draft → clear selection → close frontmost panel.
   * Selection clears before panels so box-selected tokens are not left selected while a window closes.
   * Selection/draft clear is allowed even when focus is in a text field; closing panels is not.
   */
  private handleEscape(e: KeyboardEvent) {
    if (this.contextMenu.isShow) {
      this.contextMenu.close();
      this.consume(e);
      return;
    }
    if (ModalService.dismissTop()) {
      this.consume(e);
      return;
    }
    if (!Network.GuestMode()) {
      if (this.tokenPath.hasDraft && !this.tokenPath.isAnimating) {
        this.tokenPath.cancelDraft();
        this.consume(e);
        return;
      }
      if (this.sceneTools.selectionCount > 0) {
        this.sceneTools.clearSelection();
        this.consume(e);
        return;
      }
      if (this.selectionService.size > 0) {
        this.selectionService.clear();
        this.consume(e);
        return;
      }
    }
    if (this.shouldIgnore(e)) return;
    if (PanelService.closeFrontmostPanel()) {
      this.consume(e);
    }
  }

  private hasTextSelection(): boolean {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount < 1 || sel.isCollapsed) return false;
    return sel.toString().length > 0;
  }

  private consume(e: KeyboardEvent) {
    e.preventDefault();
    e.stopPropagation();
  }

  private moveDeltaFromPressed(): { dx: number, dy: number } | null {
    let dx = 0;
    let dy = 0;
    if (this.pressed.has('KeyW') || this.pressed.has('ArrowUp')) dy -= 1;
    if (this.pressed.has('KeyS') || this.pressed.has('ArrowDown')) dy += 1;
    if (this.pressed.has('KeyA') || this.pressed.has('ArrowLeft')) dx -= 1;
    if (this.pressed.has('KeyD') || this.pressed.has('ArrowRight')) dx += 1;
    if (dx === 0 && dy === 0) return null;
    return { dx, dy };
  }

  private beginOrContinueMoveSession(moveTargets: TabletopObject[]) {
    this.cancelTapGlide();
    const delta = this.moveDeltaFromPressed();
    if (delta) this.moveSessionLastDir = delta;
    if (!this.moveLoopRaf) {
      this.moveReleaseHandled = false;
      this.moveSessionStartMs = performance.now();
      this.moveSessionStartPos.clear();
      const targets = moveTargets.length
        ? moveTargets
        : (this.sceneTools.selectionCount > 0 ? [] : this.shortcutTargets());
      if (targets.length) {
        MovableSelectionSynchronizer.beginKeyboardNudge(targets);
        for (const object of targets) {
          const pos = this.livePosOf(object);
          if (pos) this.moveSessionStartPos.set(object.identifier, pos);
        }
      }
    }
    this.ensureContinuousMoveLoop();
  }

  private livePosOf(object: TabletopObject): { x: number; y: number } | null {
    const live = MovableDirective.livePoseFor(object.identifier);
    if (live) return { x: live.x, y: live.y };
    const pose = object.getPoseForView?.() ?? object.location;
    if (!pose) return null;
    return { x: pose.x, y: pose.y };
  }

  /** While WASD/arrows held: move every frame and refresh shadows (pointer-drag parity). */
  private ensureContinuousMoveLoop() {
    if (this.moveLoopRaf) return;
    this.moveLoopLastTs = performance.now();
    this.ngZone.runOutsideAngular(() => {
      const tick = (now: number) => {
        if (!this.moveDeltaFromPressed()) {
          this.moveLoopRaf = 0;
          this.onMoveKeysReleased();
          return;
        }
        const dt = Math.min(0.05, Math.max(0, (now - this.moveLoopLastTs) / 1000));
        this.moveLoopLastTs = now;
        this.runInAngular(() => this.applyContinuousMove(dt));
        this.moveLoopRaf = requestAnimationFrame(tick);
      };
      this.moveLoopRaf = requestAnimationFrame(tick);
    });
  }

  private stopContinuousMoveLoop(finish: boolean) {
    if (this.moveLoopRaf) {
      cancelAnimationFrame(this.moveLoopRaf);
      this.moveLoopRaf = 0;
    }
    if (finish) this.onMoveKeysReleased();
  }

  private applyContinuousMove(dt: number) {
    if (dt <= 0) return;
    const delta = this.moveDeltaFromPressed();
    if (!delta) return;
    this.moveSessionLastDir = delta;
    const grid = TableSelecter.instance.viewTable?.gridSize ?? 50;
    const len = Math.hypot(delta.dx, delta.dy) || 1;
    const speed = grid * TabletopKeyboardService.MOVE_CELLS_PER_SEC;
    const dx = (delta.dx / len) * speed * dt;
    const dy = (delta.dy / len) * speed * dt;

    if (this.sceneTools.selectionCount > 0) {
      this.sceneTools.nudgeSelection(dx, dy);
      return;
    }
    const moveTargets = this.shortcutTargets();
    if (moveTargets.length < 1) return;
    MovableSelectionSynchronizer.nudge(moveTargets, dx, dy);
  }

  /** Key released: short tap glides to one cell; longer hold snaps/flushes like drag end. */
  private onMoveKeysReleased() {
    if (this.moveReleaseHandled || this.tapGlideRaf) return;
    if (this.sceneTools.selectionCount > 0) {
      this.finishContinuousMove();
      return;
    }
    const targets = this.shortcutTargets();
    const dir = this.moveSessionLastDir;
    const grid = TableSelecter.instance.viewTable?.gridSize ?? 50;
    const elapsed = performance.now() - this.moveSessionStartMs;
    if (targets.length && dir && elapsed <= TabletopKeyboardService.TAP_COMPLETE_MS
      && this.shouldCompleteTapCell(targets, dir, grid)) {
      this.startTapGlide(targets, dir, grid);
      return;
    }
    this.finishContinuousMove();
  }

  private shouldCompleteTapCell(
    targets: TabletopObject[],
    dir: { dx: number; dy: number },
    grid: number,
  ): boolean {
    const len = Math.hypot(dir.dx, dir.dy) || 1;
    const need = grid * 0.45;
    for (const object of targets) {
      const start = this.moveSessionStartPos.get(object.identifier);
      const now = this.livePosOf(object);
      if (!start || !now) continue;
      const along = ((now.x - start.x) * dir.dx + (now.y - start.y) * dir.dy) / len;
      if (along < need) return true;
    }
    return false;
  }

  private startTapGlide(
    targets: TabletopObject[],
    dir: { dx: number; dy: number },
    grid: number,
  ) {
    this.cancelTapGlide();
    MovableSelectionSynchronizer.beginKeyboardNudge(targets);
    const len = Math.hypot(dir.dx, dir.dy) || 1;
    const nx = dir.dx / len;
    const ny = dir.dy / len;
    const from = new Map<string, { x: number; y: number }>();
    const to = new Map<string, { x: number; y: number }>();
    for (const object of targets) {
      const start = this.moveSessionStartPos.get(object.identifier) ?? this.livePosOf(object);
      const cur = this.livePosOf(object);
      if (!start || !cur) continue;
      from.set(object.identifier, cur);
      to.set(object.identifier, {
        x: start.x + nx * grid,
        y: start.y + ny * grid,
      });
    }
    if (to.size < 1) {
      this.finishContinuousMove();
      return;
    }
    const duration = TabletopKeyboardService.TAP_GLIDE_MS;
    const t0 = performance.now();
    this.ngZone.runOutsideAngular(() => {
      const tick = (now: number) => {
        const u = Math.min(1, (now - t0) / duration);
        const ease = u * (2 - u);
        this.runInAngular(() => {
          for (const object of targets) {
            const a = from.get(object.identifier);
            const b = to.get(object.identifier);
            if (!a || !b) continue;
            const x = a.x + (b.x - a.x) * ease;
            const y = a.y + (b.y - a.y) * ease;
            this.setObjectLivePos(object, x, y);
          }
          EventSystem.trigger('TABLETOP_DRAG_MOVE', { source: 'nudge-glide' });
        });
        if (u < 1) {
          this.tapGlideRaf = requestAnimationFrame(tick);
        } else {
          this.tapGlideRaf = 0;
          SoundEffect.playLocal(PresetSound.piecePut);
          this.finishContinuousMove();
        }
      };
      this.tapGlideRaf = requestAnimationFrame(tick);
    });
  }

  private setObjectLivePos(object: TabletopObject, x: number, y: number) {
    const cur = this.livePosOf(object);
    if (!cur) return;
    MovableSelectionSynchronizer.nudge([object], x - cur.x, y - cur.y);
  }

  private cancelTapGlide() {
    if (!this.tapGlideRaf) return;
    cancelAnimationFrame(this.tapGlideRaf);
    this.tapGlideRaf = 0;
  }

  /** Snap + flush after hold/glide ends so SyncVars match the final visual pose. */
  private finishContinuousMove() {
    this.cancelTapGlide();
    this.moveReleaseHandled = true;
    this.runInAngular(() => {
      MovableSelectionSynchronizer.finishKeyboardNudge(
        this.shortcutTargets(),
        TableSelecter.instance.gridSnap,
      );
    });
    this.moveSessionStartPos.clear();
    this.moveSessionLastDir = null;
  }

  private facingAngleFromPressed(): number | null {
    const delta = this.moveDeltaFromPressed();
    if (!delta) return null;
    let angle = Math.atan2(delta.dx, -delta.dy) * 180 / Math.PI;
    if (angle < 0) angle += 360;
    return angle;
  }

  private changeLayerOrder(toFront: boolean): boolean {
    const targets = this.shortcutTargets();
    if (targets.length < 1) return false;
    const before = this.snapshotZindexes(targets);
    const beforeOrder = this.snapshotChildOrders(targets);
    let changed = false;
    // Process back→front when bringing forward (and reverse when sending back) so
    // multi-select keeps relative order while moving as a group.
    const objects = targets.slice().sort((a, b) => {
      const za = 'zindex' in a ? (a as Stackable).zindex : 0;
      const zb = 'zindex' in b ? (b as Stackable).zindex : 0;
      return toFront ? za - zb : zb - za;
    });
    for (const object of objects) {
      // Lock blocks drag/delete, not [ ] paint order — default clue masks ship locked.
      const did = toFront ? this.bringToFront(object) : this.sendToBack(object);
      if (did) changed = true;
    }
    if (changed) {
      const after = this.snapshotZindexes(targets);
      const afterOrder = this.snapshotChildOrders(targets);
      this.undoService.recordLayerChange(before, after, beforeOrder, afterOrder, 'layer');
      // Stackable toTopmost/toBackmost already emit TABLETOP_LAYER_CHANGED via util.
      // Re-firing here doubles detectChanges and makes every token flash on [ ].
      const needsExtraLayerEvent = objects.some(o => {
        if (o instanceof Terrain) return true;
        if (typeof (o as any).toTopmost === 'function' || typeof (o as any).toBackmost === 'function') {
          return false;
        }
        return !('zindex' in o);
      });
      if (needsExtraLayerEvent) {
        EventSystem.trigger('TABLETOP_LAYER_CHANGED', {
          toFront,
          ids: objects.map(o => o.identifier),
        });
      }
    }
    return changed;
  }

  private snapshotZindexes(objects: TabletopObject[]): Map<string, number> {
    const map = new Map<string, number>();
    // Snapshot the whole shared layer space (not only selected aliases).
    for (const alias of ['text-note', 'card', 'card-stack', 'range', 'table-mask', 'character']) {
      for (const peer of ObjectStore.instance.getObjects(alias) as Stackable[]) {
        if (!peer.isVisibleOnTable) continue;
        if (typeof peer.zindex !== 'number') continue;
        map.set(peer.identifier, peer.zindex);
      }
    }
    return map;
  }

  private snapshotChildOrders(objects: TabletopObject[]): Map<string, string[]> {
    const map = new Map<string, string[]>();
    for (const object of objects) {
      if (!(object instanceof Terrain || object instanceof GameTableMask)) continue;
      const parent = (object as ObjectNode).parent;
      if (!parent || map.has(parent.identifier)) continue;
      map.set(parent.identifier, parent.children.map(c => c.identifier));
    }
    return map;
  }

  private bringToFront(object: TabletopObject): boolean {
    if (typeof (object as any).toTopmost === 'function') {
      const z0 = 'zindex' in object ? (object as Stackable).zindex : null;
      (object as any).toTopmost();
      const z1 = 'zindex' in object ? (object as Stackable).zindex : null;
      // Card/Note/Mask toTopmost() → moveToTopmost; detect no-op via zindex when present.
      if (z0 != null && z1 != null) return z0 !== z1;
      return true;
    }
    // Terrains stay on parent child-order (no shared zindex with desktop pieces).
    if (object instanceof Terrain && object.parent) {
      object.parent.appendChild(object);
      return true;
    }
    if ('zindex' in object) {
      return moveToTopmost(object as Stackable);
    }
    return false;
  }

  private sendToBack(object: TabletopObject): boolean {
    if (typeof (object as any).toBackmost === 'function') {
      const z0 = 'zindex' in object ? (object as Stackable).zindex : null;
      (object as any).toBackmost();
      const z1 = 'zindex' in object ? (object as Stackable).zindex : null;
      if (z0 != null && z1 != null) return z0 !== z1;
      return true;
    }
    if (object instanceof Terrain && object.parent) {
      object.parent.prependChild(object);
      return true;
    }
    if ('zindex' in object) {
      return moveToBackmost(object as Stackable);
    }
    return false;
  }

  /** True when the in-app tabletop clipboard has something to paste. */
  get hasClipboard(): boolean {
    return this.clipboardXml.length > 0;
  }

  /**
   * True when clipboard includes a character sheet or Token
   * (temporary-paste only applies to those).
   */
  get hasCharacterClipboard(): boolean {
    const charAlias = GameCharacter.aliasName;
    const tokenAlias = CharacterToken.aliasName;
    return this.clipboardXml.some(xml => {
      const m = /^\s*<([^\s/>]+)/.exec(xml || '');
      const tag = m?.[1] || '';
      return tag === charAlias || tag === tokenAlias;
    });
  }

  /** True when scene tools (light / wall / drawing) have a selection. */
  get hasSceneSelection(): boolean {
    return this.sceneTools.selectionCount > 0;
  }

  /** Windows-style Copy: serialize current selection into the in-app clipboard. */
  copySelection(): boolean {
    return this.runInAngular(() => this.copySelectionInner());
  }

  private copySelectionInner(): boolean {
    if (Network.GuestMode()) return false;
    if (this.sceneTools.selectionCount > 0) {
      const objs = this.sceneTools.selectedObjects;
      this.clipboardXml = objs.map(object => object.toXml());
      this.clipboardSourceIds = objs.map(object => object.identifier);
      return this.clipboardXml.length > 0;
    }
    const objs = this.shortcutTargets();
    if (objs.length < 1) return false;
    this.clipboardXml = objs.map(object => object.toXml());
    this.clipboardSourceIds = objs.map(object => object.identifier);
    return this.clipboardXml.length > 0;
  }

  /** Windows-style Cut: copy then delete selection. */
  cutSelection(): boolean {
    return this.runInAngular(() => this.cutSelectionInner());
  }

  private cutSelectionInner(): boolean {
    if (!this.copySelectionInner()) return false;
    if (this.sceneTools.selectionCount > 0) {
      return this.sceneTools.deleteSelection();
    }
    return this.deleteSelection();
  }

  /** Windows-style Paste at the current pointer (same as Ctrl+V in-app path). */
  pasteAtPointer(): boolean {
    return this.runInAngular(() => this.pasteClipboard(false));
  }

  /**
   * Ctrl+Shift+V: paste as temporary Token with an independent sheet
   * (HP etc. not shared; hidden from inventory). No-op unless clipboard has character/Token.
   */
  pasteTemporaryAtPointer(): boolean {
    return this.runInAngular(() => {
      if (!this.hasCharacterClipboard) return false;
      return this.pasteClipboard(true);
    });
  }

  /**
   * Right-click Windows behavior: if the target is not already selected,
   * make it the sole selection before Copy/Cut menus run.
   */
  ensureObjectSelected(object: TabletopObject): void {
    if (!object || Network.GuestMode()) return;
    if (this.selectionService.state(object) !== SelectionState.NONE) return;
    this.selectionService.clear();
    this.selectionService.add(object);
    if (object instanceof Terrain && object.bakeGroupId) {
      for (const sibling of terrainsInBakeGroup(object.bakeGroupId)) {
        this.selectionService.add(sibling);
      }
    }
  }

  /**
   * Hotkey T / context menu: if selection is only cards + stacks (≥2 pieces),
   * merge into one deck at `position`; otherwise congregate to that point.
   */
  congregateOrMergeSelection(position?: PointerCoordinate): boolean {
    return this.runInAngular(() => this.congregateOrMergeSelectionInner(position));
  }

  private congregateOrMergeSelectionInner(position?: PointerCoordinate): boolean {
    if (Network.GuestMode()) return false;
    const targets = this.selectionService.size > 0
      ? this.selectionService.objects
      : this.shortcutTargets();
    if (targets.length < 1) return false;
    const pointer = position ?? this.coordinateService.calcTabletopLocalCoordinate();
    if (this.tryMergeCardsAndStacks(targets, pointer)) return true;
    MovableSelectionSynchronizer.congregate(pointer, targets);
    SoundEffect.play(PresetSound.piecePut);
    return true;
  }

  private congregateSelectionToPointer(): boolean {
    return this.congregateOrMergeSelectionInner();
  }

  /**
   * Merge free cards + card stacks into one deck. Returns true when merged.
   * Requires every target to be a Card or CardStack and at least two pieces.
   */
  private tryMergeCardsAndStacks(targets: TabletopObject[], position: PointerCoordinate): boolean {
    if (targets.length < 2) return false;
    const pieces: Array<Card | CardStack> = [];
    for (const obj of targets) {
      if (obj instanceof Card || obj instanceof CardStack) pieces.push(obj);
      else return false;
    }

    const freeCards = pieces.filter((p): p is Card => p instanceof Card && !p.parent);
    const stacks = pieces.filter((p): p is CardStack => p instanceof CardStack);
    if (freeCards.length + stacks.length < 2) return false;

    let totalCards = freeCards.length;
    for (const s of stacks) totalCards += s.cards.length;
    if (totalCards < 2) return false;

    const deck = CardStack.create(this.i18n.t('card.deckDefault'));
    deck.location.x = position.x - 25;
    deck.location.y = position.y - 25;
    deck.posZ = position.z;
    deck.location.name = 'table';
    const viewId = TabletopObject.resolveViewTableIdentifier() || '';
    if (viewId) deck.tableIdentifier = viewId;
    deck.setLocation('table');

    const ordered = [...freeCards, ...stacks].sort((a, b) => {
      const za = 'zindex' in a ? (a as Card | CardStack).zindex : 0;
      const zb = 'zindex' in b ? (b as Card | CardStack).zindex : 0;
      return za - zb;
    });

    for (const piece of ordered) {
      if (piece instanceof Card) {
        deck.putOnBottom(piece);
        continue;
      }
      const drawn = piece.drawCardAll();
      for (const card of drawn) deck.putOnBottom(card);
      piece.setLocation('');
      piece.destroy();
    }

    deck.raiseInTier();
    this.selectionService.clear();
    this.selectionService.add(deck);
    SoundEffect.play(PresetSound.cardPut);
    return true;
  }

  /**
   * OS clipboard paste: CCFOLIA JSON → in-app XML → OS files/screenshot.
   * In-app XML wins over lingering Explorer "Files" after Ctrl+C on the table.
   * Skips INPUT/TEXTAREA so chat and forms keep normal paste.
   */
  private handlePaste(e: ClipboardEvent) {
    if (this.shouldIgnore(e)) return;
    if (Network.GuestMode()) return;

    if (this.ignoreNextPaste) {
      this.ignoreNextPaste = false;
      e.preventDefault();
      e.stopPropagation();
      return;
    }

    const text = e.clipboardData?.getData('text/plain') ?? '';
    const ccfolia = tryParseCcfoliaCharacter(text);
    if (ccfolia) {
      if (this.pasteCcfoliaCharacter(ccfolia)) {
        e.preventDefault();
        e.stopPropagation();
      }
      return;
    }

    // Prefer tabletop copy over OS file items (often stale from Explorer).
    if (this.clipboardXml.length > 0) {
      if (this.pasteClipboard(false)) {
        e.preventDefault();
        e.stopPropagation();
      }
      return;
    }

    const files = filesFromDataTransfer(e.clipboardData);
    if (files.length && this.tabletopFileDrop.looksAcceptable(files)) {
      e.preventDefault();
      e.stopPropagation();
      const pointer = this.coordinateService.calcTabletopLocalCoordinate();
      this.runInAngular(() => { void this.tabletopFileDrop.handleDrop(files, pointer); });
    }
  }

  private pasteCcfoliaCharacter(clipboard: CharacterClipboardData): boolean {
    if (Network.GuestMode()) return false;
    const pointer = this.coordinateService.calcTabletopLocalCoordinate();
    const character = createGameCharacterFromCcfolia(clipboard, pointer);
    const token = CharacterToken.focusTokenForCharacter(character.identifier);
    this.selectionService.clear();
    this.selectionService.add(token || character);
    this.undoService.recordCreated(token ? [token, character] : [character], 'paste');
    SoundEffect.play(PresetSound.piecePut);
    return true;
  }

  private pasteClipboard(temporary = false): boolean {
    if (Network.GuestMode()) return false;
    if (this.clipboardXml.length < 1) return false;

    const table = TableSelecter.instance.viewTable;
    const parsed: ObjectNode[] = [];
    for (let i = 0; i < this.clipboardXml.length; i++) {
      const object = ObjectSerializer.instance.parseXml(this.clipboardXml[i]);
      if (
        object instanceof TabletopObject
        || object instanceof TableLight
        || object instanceof TableWall
        || object instanceof TableDrawing
      ) {
        parsed.push(object as ObjectNode);
      }
    }
    if (parsed.length < 1) return false;

    let cx = 0;
    let cy = 0;
    for (const object of parsed) {
      const c = this.clipboardAnchorOf(object);
      cx += c.x;
      cy += c.y;
    }
    cx /= parsed.length;
    cy /= parsed.length;

    const pointer = this.coordinateService.calcTabletopLocalCoordinate();
    const dx = pointer.x - cx;
    const dy = pointer.y - cy;

    const created: ObjectNode[] = [];
    const selectTabletop: TabletopObject[] = [];
    const selectScene: { drawings: TableDrawing[]; lights: TableLight[]; walls: TableWall[] } = {
      drawings: [], lights: [], walls: [],
    };

    for (let i = 0; i < parsed.length; i++) {
      const object = parsed[i];
      this.nudgeClipboardObject(object, dx, dy);

      if (object instanceof TableLight || object instanceof TableWall || object instanceof TableDrawing) {
        if (!table) {
          object.destroy();
          continue;
        }
        table.appendChild(object);
        created.push(object);
        if (object instanceof TableLight) selectScene.lights.push(object);
        else if (object instanceof TableWall) selectScene.walls.push(object);
        else selectScene.drawings.push(object);
        continue;
      }

      if (!(object instanceof TabletopObject)) continue;

      if (object instanceof CharacterToken) {
        const viewId = TabletopObject.resolveViewTableIdentifier();
        if (temporary) {
          // Independent temporary sheet (HP etc. not shared) + Token.
          const sourceBody = object.character;
          if (sourceBody) {
            const token = GameCharacter.createTemporaryCopy(sourceBody, {
              x: object.location.x,
              y: object.location.y,
              posZ: object.posZ,
            }, viewId, object);
            object.destroy();
            created.push(token);
            selectTabletop.push(token);
          } else {
            object.isTemporaryCopy = true;
            object.tablePlacements = '';
            object.addToTable(viewId, {
              x: object.location.x,
              y: object.location.y,
              posZ: object.posZ,
            }, true);
            created.push(object);
            selectTabletop.push(object);
          }
        } else {
          object.tablePlacements = '';
          object.addToTable(viewId, {
            x: object.location.x,
            y: object.location.y,
            posZ: object.posZ,
          }, true);
          // Keep existing major; only FIRST COME if this map had none (do not steal).
          CharacterToken.reconcileMajor(object.characterId, viewId);
          created.push(object);
          selectTabletop.push(object);
        }
      } else if (object instanceof GameCharacter) {
        // Legacy clipboard: convert pasted body-on-table into a token projection.
        const viewId = TabletopObject.resolveViewTableIdentifier();
        if (temporary) {
          // Parsed GameCharacter is already a sheet clone — mark temp and project.
          object.isTemporaryCopy = true;
          object.isInventoryIndicate = false;
          CharacterToken.ensureBodyOffTable(object);
          const token = CharacterToken.create(object.identifier, {
            x: object.location.x,
            y: object.location.y,
            posZ: object.posZ,
          }, {
            tableId: viewId,
            temporary: true,
            copyAppearanceFrom: object,
          });
          created.push(token);
          selectTabletop.push(token);
        } else {
          const token = CharacterToken.create(object.identifier, {
            x: object.location.x,
            y: object.location.y,
            posZ: object.posZ,
          }, { tableId: viewId, copyAppearanceFrom: object });
          CharacterToken.ensureBodyOffTable(object);
          created.push(token);
          selectTabletop.push(token);
        }
      } else if (object instanceof Terrain) {
        object.isLocked = false;
        if (table) table.appendChild(object);
        created.push(object);
        selectTabletop.push(object);
      } else if (object instanceof GameTableMask) {
        object.isLock = false;
        object.isPreview = false;
        if (table) table.appendChild(object);
        created.push(object);
        selectTabletop.push(object);
      } else if (object instanceof DiceSymbol) {
        const viewId = TabletopObject.resolveViewTableIdentifier();
        object.tablePlacements = '';
        object.addToTable(viewId, {
          x: object.location.x,
          y: object.location.y,
          posZ: object.posZ,
        }, true);
        created.push(object);
        selectTabletop.push(object);
      } else if (object instanceof TextNote) {
        const placed = this.pasteTextNote(object, i);
        if (placed) {
          if (placed !== object) {
            // Source note rebound across maps — content stays shared; not a new create.
            selectTabletop.push(placed);
          } else {
            created.push(placed);
            selectTabletop.push(placed);
          }
        }
      } else if (object instanceof Card) {
        object.isLocked = false;
        object.raiseInTier();
        const viewId = TabletopObject.resolveViewTableIdentifier();
        if (object.location.name === 'table' || !object.parent) {
          object.tablePlacements = '';
          object.addToTable(viewId, {
            x: object.location.x,
            y: object.location.y,
            posZ: object.posZ,
          }, true);
        }
        created.push(object);
        selectTabletop.push(object);
      } else if (object instanceof CardStack) {
        object.isLocked = false;
        object.owner = '';
        object.raiseInTier();
        const viewId = TabletopObject.resolveViewTableIdentifier();
        object.tablePlacements = '';
        object.addToTable(viewId, {
          x: object.location.x,
          y: object.location.y,
          posZ: object.posZ,
        }, true);
        created.push(object);
        selectTabletop.push(object);
      } else if (object instanceof RangeArea) {
        object.isLocked = false;
        object.toTopmost();
        const viewId = TabletopObject.resolveViewTableIdentifier();
        object.tablePlacements = '';
        object.addToTable(viewId, {
          x: object.location.x,
          y: object.location.y,
          posZ: object.posZ,
        }, true);
        created.push(object);
        selectTabletop.push(object);
      } else {
        object.update();
        created.push(object);
        selectTabletop.push(object);
      }
    }

    if (created.length < 1 && selectTabletop.length < 1
      && selectScene.drawings.length + selectScene.lights.length + selectScene.walls.length < 1) {
      return false;
    }

    this.selectionService.clear();
    this.sceneTools.clearSelection();
    for (const object of selectTabletop) {
      this.selectionService.add(object);
    }
    if (selectScene.drawings.length || selectScene.lights.length || selectScene.walls.length) {
      this.sceneTools.setMultiSelection(selectScene.drawings, selectScene.lights, selectScene.walls);
    }
    reconcileLayerStack();
    if (created.length) this.undoService.recordCreated(created, 'paste');
    if (selectScene.drawings.length || selectScene.lights.length || selectScene.walls.length) {
      this.sceneTools.notifyTableUpdate();
    }
    SoundEffect.play(PresetSound.piecePut);
    return true;
  }

  /** Anchor used to center a clipboard paste group on the pointer. */
  private clipboardAnchorOf(object: ObjectNode): { x: number; y: number } {
    if (object instanceof TabletopObject) {
      return { x: object.location.x, y: object.location.y };
    }
    if (object instanceof TableLight) {
      return { x: object.x, y: object.y };
    }
    if (object instanceof TableDrawing) {
      return { x: object.x, y: object.y };
    }
    if (object instanceof TableWall) {
      const pts = object.points || [];
      if (!pts.length) return { x: 0, y: 0 };
      let sx = 0;
      let sy = 0;
      for (const p of pts) { sx += p.x; sy += p.y; }
      return { x: sx / pts.length, y: sy / pts.length };
    }
    return { x: 0, y: 0 };
  }

  private nudgeClipboardObject(object: ObjectNode, dx: number, dy: number) {
    if (object instanceof TabletopObject) {
      object.location.x += dx;
      object.location.y += dy;
      return;
    }
    if (object instanceof TableLight) {
      object.x += dx;
      object.y += dy;
      return;
    }
    if (object instanceof TableDrawing) {
      object.x += dx;
      object.y += dy;
      const geom = object.geom || {};
      const pts: { x: number; y: number }[] = geom.points || [];
      if (pts.length) {
        geom.points = pts.map(p => ({ x: p.x + dx, y: p.y + dy }));
        object.geom = geom;
      }
      return;
    }
    if (object instanceof TableWall) {
      const pts = object.points || [];
      if (pts.length) object.points = pts.map(p => ({ x: p.x + dx, y: p.y + dy }));
    }
  }

  /**
   * Paste a shared note:
   * - Cross-map (source still on another map): add placement to the same note so text stays common.
   * - Room-scoped source: relocate the shared note (already visible everywhere).
   * - Same-map / cut-restore: keep the parsed clone with copied content.
   */
  private pasteTextNote(clone: TextNote, clipboardIndex: number): TextNote | null {
    const viewId = TabletopObject.resolveViewTableIdentifier();
    const x = clone.location.x;
    const y = clone.location.y;
    const posZ = clone.posZ;
    const srcId = this.clipboardSourceIds[clipboardIndex];
    const source = srcId ? ObjectStore.instance.get<TextNote>(srcId) : null;

    if (source instanceof TextNote && source !== clone && source.location.name === 'table') {
      if (source.scope === 'room') {
        clone.destroy();
        source.isLocked = false;
        source.raiseInTier();
        source.addToTable(viewId, { x, y, posZ }, true);
        return source;
      }
      if (viewId && !source.hasPlacement(viewId)) {
        // Cross-map copy: same note body on the new map → content stays common.
        clone.destroy();
        source.isLocked = false;
        source.raiseInTier();
        source.addToTable(viewId, { x, y, posZ }, false);
        return source;
      }
    }

    clone.isLocked = false;
    clone.raiseInTier();
    // Ensure note body survives clipboard (value + currentValue).
    const body = clone.text;
    const title = clone.title;
    clone.tablePlacements = '';
    clone.addToTable(viewId, { x, y, posZ }, true);
    if (body) clone.text = body;
    if (title) clone.title = title;
    return clone;
  }

  private deleteSelection(): boolean {
    if (Network.GuestMode()) return false;
    const targets = [...this.shortcutTargets()];
    if (targets.length < 1) return false;

    const entries: DeleteEntry[] = [];
    let deleted = false;

    for (const object of targets) {
      if (this.isLocked(object)) continue;

      if (object instanceof CharacterToken) {
        entries.push({
          kind: 'destroy',
          xml: object.toXml(),
          parentId: TableSelecter.instance.viewTable?.identifier || '',
          liveId: object.identifier,
        });
        this.selectionService.remove(object);
        CharacterToken.destroyToken(object);
        deleted = true;
        continue;
      }

      if (object instanceof GameCharacter) {
        CharacterToken.destroyTokensForCharacter(object.identifier);
        entries.push({
          kind: 'graveyard',
          id: object.identifier,
          fromLocation: object.location.name,
          fromTableIdentifier: object.tableIdentifier || TabletopObject.resolveViewTableIdentifier() || '',
        });
        EventSystem.call('FAREWELL_STAND_IMAGE', { characterIdentifier: object.identifier });
        if (object.location.name === 'table') {
          object.leaveCurrentTable('graveyard');
        } else {
          object.setLocation('graveyard');
        }
        this.selectionService.remove(object);
        deleted = true;
        continue;
      }

      if (object instanceof TextNote) {
        if (object.location.name === 'graveyard') {
          entries.push({
            kind: 'destroy',
            xml: object.toXml(),
            parentId: (object as ObjectNode).parentId || TableSelecter.instance.viewTable?.identifier || '',
            liveId: object.identifier,
          });
          object.destroy();
        } else {
          entries.push({
            kind: 'graveyard',
            id: object.identifier,
            fromLocation: object.location.name,
            fromTableIdentifier: object.tableIdentifier || TabletopObject.resolveViewTableIdentifier() || '',
          });
          if (object.location.name === 'table') {
            object.leaveCurrentTable('graveyard');
          } else {
            object.setLocation('graveyard');
          }
        }
        this.selectionService.remove(object);
        deleted = true;
        continue;
      }

      entries.push({
        kind: 'destroy',
        xml: object.toXml(),
        parentId: (object as ObjectNode).parentId || TableSelecter.instance.viewTable?.identifier || '',
        liveId: object.identifier,
      });
      object.destroy();
      this.selectionService.remove(object);
      deleted = true;
    }

    if (deleted) {
      this.undoService.recordDeleted(entries, 'delete');
      SoundEffect.play(PresetSound.sweep);
    }
    return deleted;
  }

  private digitIndexFromCode(code: string): number | null {
    if (/^Digit[1-9]$/.test(code)) return code.charCodeAt(5) - 49; // '1' → 0
    if (/^Numpad[1-9]$/.test(code)) return code.charCodeAt(6) - 49;
    return null;
  }

  /** Switch to the Nth viewable chat tab (0-based) and open chat if needed. */
  private selectChatTabByIndex(index: number): boolean {
    const tabs = ChatTabList.instance.chatTabs.filter(tab => tab.canView());
    if (index < 0 || index >= tabs.length) return false;
    const tabIdentifier = tabs[index].identifier;
    EventSystem.trigger('SHOW_CHAT', { tabIdentifier });
    return true;
  }

  private nudgeAltitude(delta: number): boolean {
    if (delta === 0) return false;
    if (TableSelecter.instance?.viewTable?.is2DMode) return false;
    let changed = false;
    for (const object of this.shortcutTargets()) {
      if (this.isLocked(object)) continue;
      if (!object.isHaveAltitude) continue;
      const next = Math.min(ALTITUDE_MAX, Math.max(ALTITUDE_MIN, object.altitude + delta));
      if (next === object.altitude) continue;
      object.altitude = next;
      changed = true;
    }
    if (changed) SoundEffect.playLocal(PresetSound.piecePut);
    return changed;
  }

  /** Flip card / turn over deck (F). Dice / coin use {@link rollDiceObjects} (R). */
  private flipCardObjects(objects: TabletopObject[]): boolean {
    let flippedCard = false;

    for (const object of objects) {
      if (this.isLocked(object)) continue;

      if (object instanceof Card) {
        if (object.isFront) object.faceDown();
        else object.faceUp();
        flippedCard = true;
        continue;
      }

      if (object instanceof CardStack) {
        if (object.isEmpty) continue;
        object.inverse();
        EventSystem.call('INVERSE_CARD_STACK', { identifier: object.identifier });
        flippedCard = true;
      }
    }

    if (flippedCard) SoundEffect.play(PresetSound.cardDraw);
    return flippedCard;
  }

  /** Coin flip or multi-face dice roll (R). */
  private rollDiceObjects(objects: DiceSymbol[]): boolean {
    let rolledCoin = false;
    let rolledDice = false;

    for (const object of objects) {
      if (this.isLocked(object)) continue;
      if (!object.isVisible && !PeerCursor.myCursor?.isGMMode) continue;
      if (object.isCoin) {
        const faces = object.faces;
        if (faces.length >= 2) {
          object.face = faces[0] === object.face ? faces[1] : faces[0];
          rolledCoin = true;
        }
      } else {
        EventSystem.call('ROLL_DICE_SYMBOL', { identifier: object.identifier });
        object.diceRoll();
        rolledDice = true;
      }
    }

    if (rolledCoin) SoundEffect.play(PresetSound.coinToss);
    if (rolledDice) SoundEffect.play(PresetSound.diceRoll1);
    return rolledCoin || rolledDice;
  }

  /** GM only: hide / reveal selected tokens (owner stealth on Token when present). */
  private toggleHideSelection(): boolean {
    if (!PeerCursor.myCursor?.isGMMode) return false;
    const hosts = this.shortcutTargets().filter(
      (o): o is GameCharacter | CharacterToken =>
        o instanceof GameCharacter || o instanceof CharacterToken
    );
    if (hosts.length < 1) return false;

    const anyVisible = hosts.some(ch => !ch.owner);
    const userId = Network.peer.userId;
    for (const ch of hosts) {
      if (anyVisible) {
        if (ch.owner) continue;
        ch.owner = userId;
        if (ch instanceof GameCharacter && !ch.visionOwner) ch.visionOwner = userId;
        if (ch instanceof CharacterToken) {
          const body = ch.character;
          if (body && !body.visionOwner) body.visionOwner = userId;
          EventSystem.call('FAREWELL_STAND_IMAGE', { characterIdentifier: ch.characterId });
        } else {
          EventSystem.call('FAREWELL_STAND_IMAGE', { characterIdentifier: ch.identifier });
        }
      } else {
        ch.owner = '';
      }
    }
    EventSystem.call('UPDATE_INVENTORY', true);
    SoundEffect.play(anyVisible ? PresetSound.sweep : PresetSound.piecePut);
    return true;
  }

  /** Toggle lock on selected objects that support isLocked / isLock. */
  private toggleLockSelection(): boolean {
    const lockable: TabletopObject[] = [];
    for (const object of this.shortcutTargets()) {
      if (object instanceof GameCharacter) continue; // soft player-owner lock only
      if ('isLocked' in object || 'isLock' in object) lockable.push(object);
    }
    if (lockable.length < 1) return false;

    const anyUnlocked = lockable.some(o => !this.hasHardLock(o));
    for (const object of lockable) {
      if ('isLocked' in object) (object as any).isLocked = anyUnlocked;
      else if ('isLock' in object) (object as any).isLock = anyUnlocked;
    }
    SoundEffect.play(anyUnlocked ? PresetSound.lock : PresetSound.unlock);
    return true;
  }

  private hasHardLock(object: TabletopObject): boolean {
    return !!(object as any).isLocked || !!(object as any).isLock;
  }

  private isLocked(object: TabletopObject): boolean {
    if (!!(object as any).isLocked || !!(object as any).isLock) return true;
    if (object instanceof GameCharacter && object.isLockedByPlayerOwner) return true;
    if (object instanceof CharacterToken && object.isLockedByPlayerOwner) return true;
    return false;
  }
}
