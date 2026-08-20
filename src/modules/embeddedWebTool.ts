import { WebContentsView } from 'electron';
import type { BrowserWindow, Rectangle } from 'electron';

interface EmbeddedWebToolOptions {
  url: string;
  preloadPath: string;
  headerHeight: number;
  footerHeight: number;
  followWindowResize: boolean;
  css?: string;
}

export function calculateEmbeddedWebToolBounds(
  contentBounds: Rectangle,
  headerHeight: number,
  footerHeight: number,
): Rectangle {
  return {
    x: 0,
    y: headerHeight,
    width: contentBounds.width,
    height: contentBounds.height - headerHeight - footerHeight,
  };
}

/** 외부 웹 페이지를 표시하는 도구 창의 WebContentsView 생명주기를 관리합니다. */
export class EmbeddedWebTool {
  private view: WebContentsView | null;
  private readonly updateBounds: () => void;

  constructor(
    private readonly window: BrowserWindow,
    private readonly options: EmbeddedWebToolOptions,
  ) {
    this.view = new WebContentsView({
      webPreferences: {
        backgroundThrottling: false,
        preload: options.preloadPath,
      },
    });
    window.contentView.addChildView(this.view);

    this.updateBounds = () => {
      if (!this.view) return;
      this.view.setBounds(calculateEmbeddedWebToolBounds(
        window.getContentBounds(),
        options.headerHeight,
        options.footerHeight,
      ));
    };
    this.updateBounds();
    if (options.followWindowResize) window.on('resize', this.updateBounds);

    this.view.webContents.loadURL(options.url);
    if (options.css) {
      this.view.webContents.on('did-finish-load', () => {
        if (this.view) void this.view.webContents.insertCSS(options.css!, { cssOrigin: 'user' });
      });
    }
  }

  openDevTools(): void {
    this.view?.webContents.openDevTools({ mode: 'detach' });
  }

  dispose(): void {
    if (this.options.followWindowResize) this.window.removeListener('resize', this.updateBounds);
    if (!this.view) return;
    try {
      this.view.webContents.close();
    } catch {
      // 창과 함께 이미 폐기된 view는 무시합니다.
    }
    this.view = null;
  }
}
