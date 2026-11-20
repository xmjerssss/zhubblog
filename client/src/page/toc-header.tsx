import { useState } from "react";
import { Modal } from "@rin/ui";

/**
 * 文章页移动端目录按钮。
 *
 * 单独成文件的原因：routes.tsx 需要静态引用它，若留在 page/feed.tsx 内，
 * 会把整条 Markdown 渲染链（unified/remark/rehype/katex/prism）拖进首屏依赖，
 * 导致首页强制预载约 256KB(br) 的 vendor-markdown。
 */
export function TOCHeader({ TOC }: { TOC: () => JSX.Element }) {
  const [isOpened, setIsOpened] = useState(false);

  return (
    <div className="shrink-0 lg:hidden">
      <button
        onClick={() => setIsOpened(true)}
        className="w-10 h-10 rounded-full flex flex-row items-center justify-center"
      >
        <i className="ri-menu-2-line text-neutral-500 transition-colors hover:text-neutral-900 dark:text-neutral-400 dark:hover:text-neutral-100 ri-lg md:ri-sm md:t-secondary"></i>
      </button>
      <Modal
        isOpen={isOpened}
        onRequestClose={() => setIsOpened(false)}
        contentLabel="Table of contents"
        size="lg"
        panelClassName="p-4"
      >
        <div className="relative max-h-[75vh] overflow-auto t-primary">
          <TOC />
        </div>
      </Modal>
    </div>
  );
}
