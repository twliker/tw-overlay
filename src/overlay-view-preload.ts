/**
 * 오버레이 WebContentsView 전용 프리로드
 * 마우스 진입/이탈 이벤트를 메인 프로세스에 전달합니다.
 */
import { ipcRenderer } from 'electron';

document.addEventListener('mouseenter', () => ipcRenderer.send('overlay-wcv-mouse-enter'));
document.addEventListener('mouseleave', () => ipcRenderer.send('overlay-wcv-mouse-leave'));
