// This file is no longer needed — using @capacitor-community/contacts instead.
// Kept as a re-export for backwards compatibility if anything imports from here.

export type ForgeContact = {
  givenName: string;
  familyName: string;
  fullName: string;
  phoneNumbers: string[];
  emails: string[];
};

// Re-export from the community plugin wrapper
export { Contacts as ContactsPlugin } from '@capacitor-community/contacts';
