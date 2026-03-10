import { registerPlugin } from '@capacitor/core';

export type ForgeContact = {
  givenName: string;
  familyName: string;
  fullName: string;
  phoneNumbers: string[];
  emails: string[];
};

type ContactsPluginType = {
  requestPermission(): Promise<{ granted: boolean }>;
  getContacts(): Promise<{ contacts: ForgeContact[] }>;
};

export const ContactsPlugin = registerPlugin<ContactsPluginType>('ContactsPlugin');
