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
