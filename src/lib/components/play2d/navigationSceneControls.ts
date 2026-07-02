export interface NavigationSceneControls {
	beginDrag: (x: number, y: number) => void;
	moveDrag: (x: number, y: number) => void;
	endDrag: (x?: number, y?: number) => void;
}
