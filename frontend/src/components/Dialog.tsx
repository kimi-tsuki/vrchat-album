import { Button, Modal } from '@heroui/react';
import type { ReactNode } from 'react';
import { Icon } from './Icon';

interface DialogProps {
  isOpen: boolean;
  onClose(): void;
  title: string;
  description?: string;
  children: ReactNode;
  footer?: ReactNode;
  size?: 'sm' | 'md' | 'lg';
  isBusy?: boolean;
}
export function Dialog({ isOpen, onClose, title, description, children, footer, size = 'md', isBusy }: DialogProps) {
  return <Modal>
    <Modal.Backdrop isOpen={isOpen} onOpenChange={open => { if (!open && !isBusy) onClose(); }} isDismissable={!isBusy} isKeyboardDismissDisabled={isBusy}>
      <Modal.Container size={size} scroll="inside">
        <Modal.Dialog aria-label={title}>
          <Modal.Header className="dialog-header"><Modal.Heading>{title}</Modal.Heading><Button variant="ghost" isIconOnly aria-label={`关闭${title}`} isDisabled={isBusy} onPress={onClose}><Icon name="close" /></Button></Modal.Header>
          <Modal.Body>{description && <p className="dialog-description">{description}</p>}{children}</Modal.Body>
          {footer && <Modal.Footer>{footer}</Modal.Footer>}
        </Modal.Dialog>
      </Modal.Container>
    </Modal.Backdrop>
  </Modal>;
}
