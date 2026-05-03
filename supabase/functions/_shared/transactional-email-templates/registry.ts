/// <reference types="npm:@types/react@18.3.1" />
import * as React from 'npm:react@18.3.1'

export interface TemplateEntry {
  component: React.ComponentType<any>
  subject: string | ((data: Record<string, any>) => string)
  to?: string
  displayName?: string
  previewData?: Record<string, any>
}

import { template as pinResetCode } from './pin-reset-code.tsx'
import { template as newDeviceLogin } from './new-device-login.tsx'

export const TEMPLATES: Record<string, TemplateEntry> = {
  'pin-reset-code': pinResetCode,
  'new-device-login': newDeviceLogin,
}
