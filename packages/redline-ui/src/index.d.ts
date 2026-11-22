export interface LineLayout {
  x: number;
  to: number;
  from: number;
  cycle: number;
  phase: number;
}

export declare class RedLines extends HTMLElement {
  lines: number;
  speed: number;
  brightness: number;
  disabled: boolean;
  replay(): void;
}
export declare function defineRedLines(tag?: string): void;
export declare function layoutLines(count: number): LineLayout[];

export declare function openModal(dialog: HTMLDialogElement): void;
export declare function closeModal(dialog: HTMLDialogElement, returnValue?: string): Promise<void>;

export type ToastVariant = 'default' | 'success' | 'error';
export declare function toast(
  message: string,
  options?: { variant?: ToastVariant; duration?: number },
): () => void;

export declare function avatarColor(seed: string): number;
export declare function initials(name: string): string;

declare global {
  interface HTMLElementTagNameMap {
    'rl-red-lines': RedLines;
  }
}
