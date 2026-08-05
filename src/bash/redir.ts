// redir.ts — Redirect classification helpers

import type { Redirect, RInstruction } from './command.js';

/** Does this redirect instruction write to a file? */
export function WRITE_REDIRECT(ri: RInstruction): boolean {
  return ri === 'r_output_direction'
    || ri === 'r_appending_to'
    || ri === 'r_output_force'
    || ri === 'r_err_and_out'
    || ri === 'r_append_err_and_out';
}

/** Is this an output redirect? */
export function OUTPUT_REDIRECT(ri: RInstruction): boolean {
  return WRITE_REDIRECT(ri)
    || ri === 'r_duplicating_output'
    || ri === 'r_duplicating_output_word'
    || ri === 'r_move_output'
    || ri === 'r_move_output_word';
}

/** Is this an input redirect? */
export function INPUT_REDIRECT(ri: RInstruction): boolean {
  return ri === 'r_input_direction'
    || ri === 'r_reading_until'
    || ri === 'r_reading_string'
    || ri === 'r_deblank_reading_until'
    || ri === 'r_duplicating_input'
    || ri === 'r_duplicating_input_word'
    || ri === 'r_input_output'
    || ri === 'r_move_input'
    || ri === 'r_move_input_word';
}

/** Does this redirect create or modify a file on disk? */
export function is_write_redirect(r: Redirect): boolean {
  return WRITE_REDIRECT(r.instruction);
}

/** Is this a truncating write (>) vs. append (>>)? */
export function is_truncate_redirect(r: Redirect): boolean {
  return r.instruction === 'r_output_direction'
    || r.instruction === 'r_output_force'
    || r.instruction === 'r_err_and_out';
}

/** Is this an append redirect? */
export function is_append_redirect(r: Redirect): boolean {
  return r.instruction === 'r_appending_to'
    || r.instruction === 'r_append_err_and_out';
}

/** Get the target filename from a redirect, or null if it's an fd redirect */
export function redirect_target_filename(r: Redirect): string | null {
  if (r.redirectee.filename) {
    return r.redirectee.filename.word;
  }
  return null;
}
