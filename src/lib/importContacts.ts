import { Capacitor } from '@capacitor/core';
import { ContactsPlugin, type ForgeContact } from '@/plugins/contacts';

export async function importIOSContacts(): Promise<ForgeContact[]> {
  if (Capacitor.getPlatform() !== 'ios') {
    throw new Error('Cette fonction est disponible uniquement sur iOS');
  }

  const permission = await ContactsPlugin.requestPermission();

  if (!permission.granted) {
    throw new Error('Permission contacts refusée');
  }

  const { contacts } = await ContactsPlugin.getContacts();

  return contacts;
}
