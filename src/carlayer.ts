import type { Layer } from './types';

export const CAR_ID = '__car__';

let blankImg: HTMLImageElement | null = null;

function getBlankImg(): HTMLImageElement {
  if (blankImg) return blankImg;
  const c = document.createElement('canvas');
  c.width = 1;
  c.height = 1;
  blankImg = new Image();
  blankImg.src = c.toDataURL();
  return blankImg;
}

export function makeCarLayer(): Layer {
  return {
    id: CAR_ID,
    name: '车体',
    kind: 'car',
    img: getBlankImg(),
    originalImg: null,
    visible: true,
    opacity: 1,
    clipToMask: false,
    flipX: false,
    transform: { x: 0, y: 0, scale: 1, rotation: 0 },
  };
}
