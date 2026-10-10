/**
 * 通用二次确认弹窗：居中的小弹层，一句标题 + 一句说明 + 取消 / 确认两个按钮。
 *
 * 只负责「问一句」，不持有任何业务状态 —— 打开与否、确认后做什么，全由调用方传入。
 * 刻意不用 Modal.Header / Modal.Footer：它们在 theme.css 里被覆写成带上下横线的样式，
 * 而本弹窗（对齐参考设计）不要横线，故标题 / 说明 / 按钮全部自排在 Modal.Body 内。
 */
import { Button, Modal } from '@heroui/react';

interface ConfirmDialogProps {
  /** 是否显示 */
  open: boolean;
  /** 弹窗标题，如「删除会话？」 */
  title: string;
  /** 补充说明（一句话讲清后果） */
  description: string;
  /** 确认按钮文案，如「删除」 */
  confirmLabel: string;
  /** 点确认按钮 */
  onConfirm: () => void;
  /** 点取消 / 点遮罩 / 按 Esc */
  onCancel: () => void;
}

export default function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  /** 遮罩点击 / Esc 关闭时，等价于点「取消」 */
  function handleOpenChange(next: boolean): void {
    if (!next) {
      onCancel();
    }
  }

  return (
    <Modal>
      <Modal.Backdrop isOpen={open} onOpenChange={handleOpenChange} isDismissable>
        {/* 不传 size：合法取值档位无法在本仓核对（node_modules 未安装），
            改用默认档，并在 Dialog 上限制宽度。 */}
        <Modal.Container placement="center">
          <Modal.Dialog className="w-[360px] max-w-[calc(100vw-40px)]">
            {/* 覆盖 .modal__body 默认的 gap-4，间距交由下方各元素的 margin 控制 */}
            <Modal.Body className="gap-0">
              <h2 className="text-[15px] font-semibold text-fg">{title}</h2>
              <p className="mt-2 text-[13px] leading-relaxed text-muted">{description}</p>
              <div className="mt-5 flex justify-end gap-2">
                <Button variant="secondary" onPress={onCancel}>
                  取消
                </Button>
                <Button variant="danger" onPress={onConfirm}>
                  {confirmLabel}
                </Button>
              </div>
            </Modal.Body>
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>
    </Modal>
  );
}
