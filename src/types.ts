export type ViewKey = 'front' | 'right' | 'rear' | 'left';
export type Mode = 'orbit' | 'edit' | 'mask';
export type LayerKind = 'background' | 'art' | 'livery';
export type MaskTool = 'brush' | 'eraser' | 'wand';

export interface Transform {
  x: number;
  y: number;
  scale: number;
  rotation: number;
}

export interface Layer {
  id: string;
  name: string;
  kind: LayerKind;
  img: HTMLImageElement;
  originalImg: HTMLImageElement | null;
  visible: boolean;
  opacity: number;
  clipToMask: boolean;
  flipX: boolean;
  transform: Transform;
}

export interface ViewState {
  layers: Layer[];
  mask: HTMLCanvasElement | null;
  maskTouched: boolean;
}

export interface ViewTransform {
  scale: number;
  offsetX: number;
  offsetY: number;
}
