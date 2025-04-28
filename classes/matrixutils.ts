import * as OpenVR from "../submodules/OpenVR_TS_Bindings_Deno/openvr_bindings.ts";

export function isValidMatrix(m: OpenVR.HmdMatrix34 | null): boolean {
  if (!m) return false;
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 4; j++) {
      if (typeof m.m[i][j] !== 'number' || isNaN(m.m[i][j])) {
        return false;
      }
    }
  }
  return true;
}

export function multiplyMatrix(a: OpenVR.HmdMatrix34, b: OpenVR.HmdMatrix34): OpenVR.HmdMatrix34 {
  const result: OpenVR.HmdMatrix34 = {
    m: [
      [0, 0, 0, 0],
      [0, 0, 0, 0],
      [0, 0, 0, 0]
    ]
  };

  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 4; j++) {
      result.m[i][j] = 0;
      for (let k = 0; k < 3; k++) {
        result.m[i][j] += a.m[i][k] * b.m[k][j];
      }
      if (j === 3) {
        result.m[i][j] += a.m[i][3];
      }
    }
  }

  return result;
}

export function invertMatrix(m: OpenVR.HmdMatrix34): OpenVR.HmdMatrix34 {
  const result: OpenVR.HmdMatrix34 = {
    m: [
      [1, 0, 0, 0],
      [0, 1, 0, 0],
      [0, 0, 1, 0]
    ]
  };

  // Invert 3x3 rotation matrix
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) {
      result.m[i][j] = m.m[j][i];
    }
  }

  // Invert translation
  for (let i = 0; i < 3; i++) {
    result.m[i][3] = -(
      result.m[i][0] * m.m[0][3] +
      result.m[i][1] * m.m[1][3] +
      result.m[i][2] * m.m[2][3]
    );
  }

  return result;
}

export function matrixEquals(a: OpenVR.HmdMatrix34, b: OpenVR.HmdMatrix34): boolean {
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 4; j++) {
      if (Math.abs(a.m[i][j] - b.m[i][j]) > 0.0001) {
        return false;
      }
    }
  }
  return true;
}

export function invertMatrix4(mat: Float32Array): Float32Array | null {
  const out = new Float32Array(16);
  const m = mat; // Alias for shorter lines

  const m00 = m[0], m01 = m[1], m02 = m[2], m03 = m[3];
  const m10 = m[4], m11 = m[5], m12 = m[6], m13 = m[7];
  const m20 = m[8], m21 = m[9], m22 = m[10], m23 = m[11];
  const m30 = m[12], m31 = m[13], m32 = m[14], m33 = m[15];

  const b00 = m00 * m11 - m01 * m10;
  const b01 = m00 * m12 - m02 * m10;
  const b02 = m00 * m13 - m03 * m10;
  const b03 = m01 * m12 - m02 * m11;
  const b04 = m01 * m13 - m03 * m11;
  const b05 = m02 * m13 - m03 * m12;
  const b06 = m20 * m31 - m21 * m30;
  const b07 = m20 * m32 - m22 * m30;
  const b08 = m20 * m33 - m23 * m30;
  const b09 = m21 * m32 - m22 * m31;
  const b10 = m21 * m33 - m23 * m31;
  const b11 = m22 * m33 - m23 * m32;

  // Calculate the determinant
  let det = b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06;

  if (!det) {
    console.error("Matrix is not invertible!");
    return null;
  }
  det = 1.0 / det;

  out[0] = (m11 * b11 - m12 * b10 + m13 * b09) * det;
  out[1] = (m02 * b10 - m01 * b11 - m03 * b09) * det;
  out[2] = (m31 * b05 - m32 * b04 + m33 * b03) * det;
  out[3] = (m22 * b04 - m21 * b05 - m23 * b03) * det;
  out[4] = (m12 * b08 - m10 * b11 - m13 * b07) * det;
  out[5] = (m00 * b11 - m02 * b08 + m03 * b07) * det;
  out[6] = (m32 * b02 - m30 * b05 - m33 * b01) * det;
  out[7] = (m20 * b05 - m22 * b02 + m23 * b01) * det;
  out[8] = (m10 * b10 - m11 * b08 + m13 * b06) * det;
  out[9] = (m01 * b08 - m00 * b10 - m03 * b06) * det;
  out[10] = (m30 * b04 - m31 * b02 + m33 * b00) * det;
  out[11] = (m21 * b02 - m20 * b04 - m23 * b00) * det;
  out[12] = (m11 * b07 - m10 * b09 - m12 * b06) * det;
  out[13] = (m00 * b09 - m01 * b07 + m02 * b06) * det;
  out[14] = (m31 * b01 - m30 * b03 - m32 * b00) * det;
  out[15] = (m20 * b03 - m21 * b01 + m22 * b00) * det;

  return out;
}

export function scaleMatrix4(mat: Float32Array, scaleVec: [number, number, number]): Float32Array {
  // Scales a 4x4 matrix by a vector (modifies columns)
  // Note: Assumes column-major input matrix 'mat'
  const out = new Float32Array(mat); // Copy existing matrix
  out[0] *= scaleVec[0]; out[1] *= scaleVec[0]; out[2] *= scaleVec[0]; out[3] *= scaleVec[0]; // Scale X column
  out[4] *= scaleVec[1]; out[5] *= scaleVec[1]; out[6] *= scaleVec[1]; out[7] *= scaleVec[1]; // Scale Y column
  out[8] *= scaleVec[2]; out[9] *= scaleVec[2]; out[10] *= scaleVec[2]; out[11] *= scaleVec[2]; // Scale Z column
  // W column (translation) remains unchanged by this type of scale
  return out;
}