// Parasolid transmit (XT) node layouts: the field sequence of each node type in the base schema that files from
// Parasolid V14 on describe their own schema against (SCH_13006), written from the published XT Format Reference and
// checked against real transmit files. Field types: d int, p pointer, f double, c char, l logical, u byte, n short,
// w unicode short, v vector (3 doubles), i interval (2), b box (6), h hvec (3: only its position is transmitted).

/** A field: its type and count (0 a scalar, 1 the variable-length last field, n > 1 a fixed array). */
export interface XTField {
  readonly name: string;
  readonly type: string;
  readonly count: number;
}

const common = 'node_id:d attributes_groups:p owner:p next:p previous:p geometric_owner:p sense:c';

/** Node type number, name and fields ("name:type", "name:type[n]", "name:type[]" for the variable last field). */
const BASE: readonly [number, string, string][] = [
  [
    10,
    'ASSEMBLY',
    'highest_node_id:d attributes_groups:p attribute_chains:p list:p surface:p curve:p point:p key:p res_size:f res_linear:f ref_instance:p next:p previous:p state:u owner:p type:u sub_instance:p',
  ],
  [
    11,
    'INSTANCE',
    'node_id:d attributes_groups:p type:u part:p transform:p assembly:p next_in_part:p prev_in_part:p next_of_part:p prev_of_part:p',
  ],
  [
    12,
    'BODY',
    'highest_node_id:d attributes_groups:p attribute_chains:p surface:p curve:p point:p key:p res_size:f res_linear:f ref_instance:p next:p previous:p state:u owner:p body_type:u nom_geom_state:u shell:p boundary_surface:p boundary_curve:p boundary_point:p region:p edge:p vertex:p',
  ],
  [13, 'SHELL', 'node_id:d attributes_groups:p body:p next:p face:p edge:p vertex:p region:p front_face:p'],
  [
    14,
    'FACE',
    'node_id:d attributes_groups:p tolerance:f next:p previous:p loop:p shell:p surface:p sense:c next_on_surface:p previous_on_surface:p next_front:p previous_front:p front_shell:p',
  ],
  [15, 'LOOP', 'node_id:d attributes_groups:p fin:p face:p next:p'],
  [
    16,
    'EDGE',
    'node_id:d attributes_groups:p tolerance:f fin:p previous:p next:p curve:p next_on_curve:p previous_on_curve:p owner:p',
  ],
  [17, 'FIN', 'attributes_groups:p loop:p forward:p backward:p vertex:p other:p edge:p curve:p next_at_vx:p sense:c'],
  [18, 'VERTEX', 'node_id:d attributes_groups:p fin:p previous:p next:p point:p tolerance:f owner:p'],
  [19, 'REGION', 'node_id:d attributes_groups:p body:p next:p previous:p shell:p type:c'],
  [29, 'POINT', 'node_id:d attributes_groups:p owner:p next:p previous:p pvec:v'],
  [30, 'LINE', `${common} pvec:v direction:v`],
  [31, 'CIRCLE', `${common} centre:v normal:v x_axis:v radius:f`],
  [32, 'ELLIPSE', `${common} centre:v normal:v x_axis:v major_radius:f minor_radius:f`],
  [38, 'INTERSECTION', `${common} surface:p[2] chart:p start:p end:p`],
  [
    40,
    'CHART',
    'base_parameter:f base_scale:f chart_count:d chordal_error:f angular_error:f parameter_error:f[2] hvec:h[]',
  ],
  [41, 'LIMIT', 'type:c hvec:h[]'],
  [45, 'BSPLINE_VERTICES', 'vertices:f[]'],
  [50, 'PLANE', `${common} pvec:v normal:v x_axis:v`],
  [51, 'CYLINDER', `${common} pvec:v axis:v radius:f x_axis:v`],
  [52, 'CONE', `${common} pvec:v axis:v radius:f sin_half_angle:f cos_half_angle:f x_axis:v`],
  [53, 'SPHERE', `${common} centre:v radius:f axis:v x_axis:v`],
  [54, 'TORUS', `${common} centre:v axis:v major_radius:f minor_radius:f x_axis:v`],
  [
    56,
    'BLENDED_EDGE',
    `${common} blend_type:c surface:p[2] spine:p range:f[2] thumb_weight:f[2] boundary:p[2] start:p end:p`,
  ],
  [59, 'BLEND_BOUND', `${common} boundary:n blend:p`],
  [60, 'OFFSET_SURF', `${common} check:c true_offset:l surface:p offset:f scale:f`],
  [67, 'SWEPT_SURF', `${common} section:p sweep:v scale:f`],
  [68, 'SPUN_SURF', `${common} profile:p base:v axis:v start:v end:v start_param:f end_param:f x_axis:v scale:f`],
  // Base LIST: the 13006 layout, as files that describe their changes against it show (list_type an int, and no
  // finger or notransmit fields).
  [
    70,
    'LIST',
    'node_id:d owner:p next:p previous:p list_type:d list_length:d block_length:d size_of_entry:d list_block:p',
  ],
  [74, 'POINTER_LIS_BLOCK', 'n_entries:d next_block:p entries:p[]'],
  [79, 'ATT_DEF_ID', 'string:c[]'],
  [80, 'ATTRIB_DEF', 'next:p identifier:p type_id:d actions:u[8] field_names:p legal_owners:l[14] fields:u[]'],
  [81, 'ATTRIBUTE', 'node_id:d definition:p owner:p next:p previous:p next_of_type:p previous_of_type:p fields:p[]'],
  [82, 'INT_VALUES', 'values:d[]'],
  [83, 'REAL_VALUES', 'values:f[]'],
  [84, 'CHAR_VALUES', 'values:c[]'],
  [85, 'POINT_VALUES', 'values:v[]'],
  [86, 'VECTOR_VALUES', 'values:v[]'],
  [87, 'AXIS_VALUES', 'values:v[]'],
  [88, 'TAG_VALUES', 'values:d[]'],
  [89, 'DIRECTION_VALUES', 'values:v[]'],
  [90, 'GROUP', 'node_id:d attributes_groups:p owner:p next:p previous:p type:u first_member:p'],
  [91, 'MEMBER_OF_GROUP', 'dummy_node_id:d owning_group:p owner:p next:p previous:p next_member:p previous_member:p'],
  [98, 'UNICODE_VALUES', 'values:w[]'],
  [99, 'FIELD_NAMES', 'names:p[]'],
  [
    100,
    'TRANSFORM',
    'node_id:d owner:p next:p previous:p rotation_matrix:f[9] translation_vector:v scale:f flag:d perspective_vector:v',
  ],
  [
    101,
    'WORLD',
    'assembly:p attribute:p body:p transform:p surface:p curve:p point:p alive:l attrib_def:p highest_id:d current_id:d',
  ],
  [102, 'KEY', 'string:c[]'],
  [120, 'PE_SURF', `${common} type:c data:p tf:p internal_geom:p[]`],
  [121, 'INT_PE_DATA', 'geom_type:d real_array:p int_array:p'],
  [122, 'EXT_PE_DATA', 'key:p real_array:p int_array:p'],
  [124, 'B_SURFACE', `${common} nurbs:p data:p`],
  [
    125,
    'SURFACE_DATA',
    'original_uint:i original_vint:i extended_uint:i extended_vint:i self_int:u original_u_start:c original_u_end:c original_v_start:c original_v_end:c extended_u_start:c extended_u_end:c extended_v_start:c extended_v_end:c analytic_form_type:c swept_form_type:c spun_form_type:c blend_form_type:c analytic_form:p swept_form:p spun_form:p blend_form:p',
  ],
  [
    126,
    'NURBS_SURF',
    'u_periodic:l v_periodic:l u_degree:n v_degree:n n_u_vertices:d n_v_vertices:d u_knot_type:u v_knot_type:u n_u_knots:d n_v_knots:d rational:l u_closed:l v_closed:l surface_form:u vertex_dim:n bspline_vertices:p u_knot_mult:p v_knot_mult:p u_knots:p v_knots:p',
  ],
  [127, 'KNOT_MULT', 'mult:n[]'],
  [128, 'KNOT_SET', 'knots:f[]'],
  [130, 'PE_CURVE', `${common} type:c data:p tf:p internal_geom:p[]`],
  [133, 'TRIMMED_CURVE', `${common} basis_curve:p point_1:v point_2:v parm_1:f parm_2:f`],
  [134, 'B_CURVE', `${common} nurbs:p data:p`],
  [135, 'CURVE_DATA', 'self_int:u analytic_form:p'],
  [
    136,
    'NURBS_CURVE',
    'degree:n n_vertices:d vertex_dim:n n_knots:d knot_type:u periodic:l closed:l rational:l curve_form:u bspline_vertices:p knot_mult:p knots:p',
  ],
  [137, 'SP_CURVE', `${common} surface:p b_curve:p original:p tolerance_to_original:f`],
  [141, 'GEOMETRIC_OWNER', 'owner:p next:p previous:p shared_geometry:p'],
  [163, 'HELIX_CU_FORM', 'axis_pt:v axis_dir:v point:v hand:c turns:i pitch:f tol:f'],
  [184, 'HELIX_SU_FORM', 'axis_pt:v axis_dir:v hand:c turns:i pitch:f gap:f tol:f'],
];

/** A node type's name and fields. */
export interface XTNodeType {
  readonly name: string;
  readonly fields: readonly XTField[];
}

const parse = (spec: string): XTField[] =>
  spec.split(/\s+/).map((f) => {
    const [name, type] = f.split(':'),
      m = /^(\w)(?:\[(\d*)\])?$/.exec(type);
    if (!m) throw new TypeError(`Parasolid schema: field ${f} is not name:type[count]; fix the schema table`);
    return { name, type: m[1], count: m[2] === undefined ? 0 : m[2] === '' ? 1 : Number(m[2]) };
  });

/** The base schema's node types by number. */
export const BASE_SCHEMA: ReadonlyMap<number, XTNodeType> = new Map(
  BASE.map(([type, name, spec]) => [type, { name, fields: parse(spec) }]),
);

/**
 * Layouts that changed after the base schema, for files that state a later schema without describing it (no base
 * suffix in their schema name): learned from files that do describe their changes.
 */
export const LATER_SCHEMA: ReadonlyMap<number, XTNodeType> = new Map([
  [
    70,
    {
      name: 'LIST',
      fields: parse(
        'node_id:d list_type:u notransmit:l owner:p next:p previous:p list_length:d block_length:d finger_index:d finger_block:p list_block:p',
      ),
    },
  ],
]);
