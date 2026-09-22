import { Injectable, NgZone, OnDestroy } from '@angular/core';
import { EventSystem } from '@udonarium/core/system';
import { TextNote } from '@udonarium/text-note';
import { PointerDeviceService } from 'service/pointer-device.service';
import {
  buildImagePayload as createImagePayload,
  buildPayloadFromNote as createNotePayload,
  buildPayloadFromNoteHandout,
  NoteHandoutLike,
  ObjectPreviewPayload,
} from 'service/object-preview-payload';
import { Subject } from 'rxjs';

export type { ObjectPreviewPayload } from 'service/object-preview-payload';

@Injectable({
  providedIn: 'root'
})
export class ObjectPreviewService implements OnDestroy {
  /**
   * True while any Object Image Preview is open — table wheel must not pan/zoom;
   * the preview layer zooms content instead.
   */
  static previewConsumesWheel = false;
  /** True while the user is dragging preview content (block map gesture steal). */
  static previewConsumesPointer = false;

  hoveredId: string | null = null;
  transient: ObjectPreviewPayload | null = null;
  pinned: ObjectPreviewPayload[] = [];

  /** Emits when a transient or pin opens — Card Hover Caption should dismiss. */
  readonly previewOpened$ = new Subject<{ id: string }>();
  /** Layer / UI should markForCheck on emit. */
  readonly stateChanged$ = new Subject<void>();

  private hoveredFactory: (() => ObjectPreviewPayload | null) | null = null;
  /** Last known MouseEvent.buttons — ignore Ctrl while any button is held. */
  private pointerButtons = 0;
  /** True while Control/Meta is down (for open-on-hover-while-held). */
  private modifierPreviewHeld = false;
  private listenersRegistered = false;

  private readonly onKeyDown = (e: KeyboardEvent) => this.handleKeyDown(e);
  private readonly onKeyUp = (e: KeyboardEvent) => this.handleKeyUp(e);
  private readonly onBlur = () => this.handleBlur();
  private readonly onMouseButtons = (e: MouseEvent) => {
    this.pointerButtons = e.buttons;
  };
  /** Bubble phase — runs after preview layer pointerup clears drag flags. */
  private readonly onPointerUp = (e: PointerEvent) => {
    this.pointerButtons = e.buttons;
    this.closeTransientIfModifierReleased();
  };

  constructor(
    private pointerDeviceService: PointerDeviceService,
    private ngZone: NgZone,
  ) {
    this.registerGlobalListeners();
    EventSystem.register(this)
      .on('DELETE_GAME_OBJECT', event => {
        const id = event.data?.identifier as string | undefined;
        if (id) this.ngZone.run(() => this.closeForObject(id));
      });
  }

  ngOnDestroy() {
    this.unregisterGlobalListeners();
    EventSystem.unregister(this);
    this.previewOpened$.complete();
    this.stateChanged$.complete();
  }

  get previewConsumesWheel(): boolean {
    return ObjectPreviewService.previewConsumesWheel;
  }

  get previewConsumesPointer(): boolean {
    return ObjectPreviewService.previewConsumesPointer;
  }

  setHovered(id: string, payloadFactory: () => ObjectPreviewPayload | null) {
    if (!id) return;
    this.hoveredId = id;
    this.hoveredFactory = payloadFactory;
    // Ctrl already held when entering hover — open without requiring a fresh keydown.
    if (this.modifierPreviewHeld) this.tryOpenTransientFromHover();
  }

  clearHovered(id: string) {
    if (!id || this.hoveredId !== id) return;
    this.hoveredId = null;
    this.hoveredFactory = null;
    // Do NOT close transient here — moving to the preview chrome (pin / zoom)
    // fires mouseleave on the card; preview stays until Ctrl/Meta is released.
  }

  pinTransient() {
    const t = this.transient;
    if (!t) return;
    const pinned: ObjectPreviewPayload = {
      ...t,
      zoom: t.zoom,
      panX: t.panX,
      panY: t.panY,
      pinned: true,
    };
    const idx = this.pinned.findIndex(p => p.id === pinned.id);
    if (idx >= 0) this.pinned[idx] = pinned;
    else this.pinned = [...this.pinned, pinned];
    this.transient = null;
    this.emitState();
  }

  closeTransient() {
    if (!this.transient) return;
    this.transient = null;
    this.emitState();
  }

  /** Hold-to-preview: close transient once Ctrl/Meta is up and no preview drag is active. */
  closeTransientIfModifierReleased() {
    if (this.modifierPreviewHeld || !this.transient) return;
    if (ObjectPreviewService.previewConsumesPointer) return;
    this.ngZone.run(() => this.closeTransient());
  }

  closePinned(id: string) {
    if (!id) return;
    const next = this.pinned.filter(p => p.id !== id);
    if (next.length === this.pinned.length) return;
    this.pinned = next;
    this.emitState();
  }

  togglePin(id?: string) {
    if (this.transient && (!id || this.transient.id === id)) {
      this.pinTransient();
      return;
    }
    if (id) this.closePinned(id);
  }

  /** Object deleted / left table — drop transient and any pin for that id. */
  closeForObject(id: string) {
    if (!id) return;
    let changed = false;
    if (this.transient?.id === id) {
      this.transient = null;
      changed = true;
    }
    const next = this.pinned.filter(p => p.id !== id);
    if (next.length !== this.pinned.length) {
      this.pinned = next;
      changed = true;
    }
    if (this.hoveredId === id) {
      this.hoveredId = null;
      this.hoveredFactory = null;
    }
    if (changed) this.emitState();
  }

  /** Update zoom/pan on the live transient or pinned payload (mutates in place). */
  updateView(id: string, patch: Partial<Pick<ObjectPreviewPayload, 'zoom' | 'panX' | 'panY' | 'pdfPage' | 'pdfPageCount'>>) {
    const target = this.findPayload(id);
    if (!target) return;
    Object.assign(target, patch);
    this.emitState();
  }

  /** Open / replace transient from an already-built payload (e.g. handout preview:true bridge). */
  openTransient(payload: ObjectPreviewPayload | null) {
    if (!payload?.id) return;
    if (!this.hasPreviewContent(payload)) return;
    this.replaceTransient({
      ...payload,
      zoom: payload.zoom ?? 1,
      panX: payload.panX ?? 0,
      panY: payload.panY ?? 0,
      pinned: false,
    });
  }

  buildPayloadFromNote(note: TextNote, nameFallback = ''): ObjectPreviewPayload | null {
    return createNotePayload(note, nameFallback);
  }

  buildImagePayload(id: string, title: string, imageUrl: string): ObjectPreviewPayload | null {
    return createImagePayload(id, title, imageUrl);
  }

  fromNoteHandout(data: NoteHandoutLike, fallbackId = '', nameFallback = ''): ObjectPreviewPayload | null {
    return buildPayloadFromNoteHandout(data, fallbackId, nameFallback);
  }

  private registerGlobalListeners() {
    if (this.listenersRegistered) return;
    this.listenersRegistered = true;
    this.ngZone.runOutsideAngular(() => {
      window.addEventListener('keydown', this.onKeyDown, true);
      window.addEventListener('keyup', this.onKeyUp, true);
      window.addEventListener('blur', this.onBlur);
      window.addEventListener('mousedown', this.onMouseButtons, true);
      window.addEventListener('mousemove', this.onMouseButtons, true);
      window.addEventListener('mouseup', this.onMouseButtons, true);
      window.addEventListener('pointerdown', this.onMouseButtons as EventListener, true);
      window.addEventListener('pointermove', this.onMouseButtons as EventListener, true);
      window.addEventListener('pointerup', this.onPointerUp, false);
    });
  }

  private unregisterGlobalListeners() {
    if (!this.listenersRegistered) return;
    this.listenersRegistered = false;
    window.removeEventListener('keydown', this.onKeyDown, true);
    window.removeEventListener('keyup', this.onKeyUp, true);
    window.removeEventListener('blur', this.onBlur);
    window.removeEventListener('mousedown', this.onMouseButtons, true);
    window.removeEventListener('mousemove', this.onMouseButtons, true);
    window.removeEventListener('mouseup', this.onMouseButtons, true);
    window.removeEventListener('pointerdown', this.onMouseButtons as EventListener, true);
    window.removeEventListener('pointermove', this.onMouseButtons as EventListener, true);
    window.removeEventListener('pointerup', this.onPointerUp, false);
  }

  private handleKeyDown(e: KeyboardEvent) {
    if (e.key !== 'Control' && e.key !== 'Meta') return;
    this.modifierPreviewHeld = true;
    if (e.repeat) return;
    if (this.pointerButtons > 0) return;
    this.tryOpenTransientFromHover();
  }

  private handleKeyUp(e: KeyboardEvent) {
    if (e.key !== 'Control' && e.key !== 'Meta') return;
    this.modifierPreviewHeld = false;
    if (this.pointerButtons > 0) return;
    this.closeTransientIfModifierReleased();
  }

  private handleBlur() {
    this.pointerButtons = 0;
    this.modifierPreviewHeld = false;
    this.ngZone.run(() => this.closeTransient());
  }

  private tryOpenTransientFromHover() {
    if (!this.hoveredId || !this.hoveredFactory) return;
    if (this.pointerDeviceService.isDragging) return;
    if (this.pointerButtons > 0) return;
    const payload = this.hoveredFactory();
    if (!payload || !this.hasPreviewContent(payload)) return;
    // Already showing this object — keep zoom/pan.
    if (this.transient?.id === payload.id) return;
    this.ngZone.run(() => {
      this.replaceTransient({
        ...payload,
        zoom: 1,
        panX: 0,
        panY: 0,
        pinned: false,
      });
    });
  }

  private replaceTransient(payload: ObjectPreviewPayload) {
    this.transient = payload;
    this.previewOpened$.next({ id: payload.id });
    this.emitState();
  }

  private findPayload(id: string): ObjectPreviewPayload | null {
    if (this.transient?.id === id) return this.transient;
    return this.pinned.find(p => p.id === id) || null;
  }

  private hasPreviewContent(p: ObjectPreviewPayload): boolean {
    return !!(p.imageUrl || p.pdfIdentifier || p.videoUrl || p.videoIdentifier || p.text);
  }

  private emitState() {
    this.stateChanged$.next();
  }
}
