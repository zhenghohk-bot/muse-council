import { pioneerById } from "@/data/pioneers";
import type { SourceNote } from "@/lib/types";

function scoreNote(question: string, note: SourceNote) {
  const haystack = `${note.title}${note.note}${note.usageHint}`.toLowerCase();
  return question
    .toLowerCase()
    .split(/[\s,，。！？、]+/)
    .filter(Boolean)
    .reduce((score, token) => score + (haystack.includes(token) ? 1 : 0), 0);
}

export function retrieveSourceNotes(pioneerId: string, question: string, limit = 2) {
  const pioneer = pioneerById.get(pioneerId);
  if (!pioneer) return [];

  return [...pioneer.sourceNotes]
    .sort((a, b) => scoreNote(question, b) - scoreNote(question, a))
    .slice(0, limit);
}

export function getSourceNotesByIds(ids: string[]) {
  return ids
    .map((id) => {
      for (const pioneer of pioneerById.values()) {
        const note = pioneer.sourceNotes.find((sourceNote) => sourceNote.id === id);
        if (note) return note;
      }
      return undefined;
    })
    .filter((note): note is SourceNote => Boolean(note));
}
