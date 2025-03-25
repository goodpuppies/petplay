import * as OpenVR from "../submodules/OpenVR_TS_Bindings_Deno/openvr_bindings.ts";
import { CustomLogger } from "./customlogger.ts";

export interface Position {
    x: number;
    y: number;
    z: number;
}

export interface Rotation {
    yaw: number;
}

export class TransformStabilizer2 {
    private lastStableTransform: OpenVR.HmdMatrix34 | null = null;
    private readonly baseThreshold = 0.001; // Small threshold for smooth movement
    private readonly maxThreshold = 4.0;  // Maximum threshold for fast movements
    private readonly deadzoneThreshold = 0.2; // Large threshold when head is stationary
    private readonly rotationThreshold = Math.PI / 2; // 90 degrees
    private readonly significantMovementThreshold = 0.2; // Velocity threshold for significant movement
    private readonly significantRotationThreshold = Math.PI / 3; // About 45 degrees/sec
    private readonly resetDeadzoneVelocityThreshold = 0.02; // Reset deadzone when movement is very small
    private readonly resetDeadzoneRotationThreshold = Math.PI / 64; // About 2.8 degrees/sec
    private lastLogTime = 0;
    private lastAssumedLogTime = 0;
    private stablePosition: Position | null = null;
    private lastHmdPosition: Position | null = null;
    private lastHmdRotation: Rotation | null = null;
    private lastHmdTime: number = 0;
    private currentHmdVelocity: number = 0;
    private currentHmdRotationVelocity: number = 0;
    private hasExceededDeadzone: boolean = false;

    constructor() {}

    private shouldLog(): boolean {
        const now = Date.now();
        if (now - this.lastLogTime >= 1000) {
            this.lastLogTime = now;
            return true;
        }
        return false;
    }

    private shouldLogAssumed(): boolean {
        const now = Date.now();
        if (now - this.lastAssumedLogTime >= 1000) {
            this.lastAssumedLogTime = now;
            return true;
        }
        return false;
    }

    private extractPosition(matrix: OpenVR.HmdMatrix34): Position {
        return {
            x: matrix.m[0][3],
            y: matrix.m[1][3],
            z: matrix.m[2][3]
        };
    }

    private extractRotation(matrix: OpenVR.HmdMatrix34): Rotation {
        return {
            yaw: Math.atan2(matrix.m[0][2], matrix.m[0][0])
        };
    }

    private calculateDistance(pos1: Position, pos2: Position): number {
        const dx = pos1.x - pos2.x;
        const dy = pos1.y - pos2.y;
        const dz = pos1.z - pos2.z;
        return Math.sqrt(dx * dx + dy * dy + dz * dz);
    }

    private calculateRotationDelta(rot1: Rotation, rot2: Rotation): number {
        let delta = Math.abs(rot1.yaw - rot2.yaw);
        while (delta > Math.PI) delta -= 2 * Math.PI;
        return Math.abs(delta);
    }

    private updateHmdVelocities(hmdTransform: OpenVR.HmdMatrix34) {
        const currentTime = Date.now();
        const currentHmdPos = this.extractPosition(hmdTransform);
        const currentHmdRot = this.extractRotation(hmdTransform);

        if (this.lastHmdPosition && this.lastHmdRotation && this.lastHmdTime) {
            const dt = (currentTime - this.lastHmdTime) / 1000; // Convert to seconds
            if (dt > 0) {
                // Calculate linear velocity
                const distance = this.calculateDistance(currentHmdPos, this.lastHmdPosition);
                const velocity = distance / dt; // meters per second
                
                // Calculate rotation velocity
                const rotationDelta = this.calculateRotationDelta(currentHmdRot, this.lastHmdRotation);
                const rotationVelocity = rotationDelta / dt; // radians per second
                
                // Smooth the velocities using exponential moving average
                const alpha = 0.3; // Smoothing factor
                this.currentHmdVelocity = (alpha * velocity) + ((1 - alpha) * this.currentHmdVelocity);
                this.currentHmdRotationVelocity = (alpha * rotationVelocity) + ((1 - alpha) * this.currentHmdRotationVelocity);
            }
        }

        this.lastHmdPosition = currentHmdPos;
        this.lastHmdRotation = currentHmdRot;
        this.lastHmdTime = currentTime;
    }

    private getCurrentThreshold(): number {
        // Use deadzone unless we're moving significantly
        const isMovingSignificantly = 
            this.currentHmdVelocity > this.significantMovementThreshold ||
            this.currentHmdRotationVelocity > this.significantRotationThreshold;
            
        // If not moving significantly and haven't exceeded deadzone, use large threshold
        if (!isMovingSignificantly && !this.hasExceededDeadzone) {
            return this.deadzoneThreshold;
        }
        
        // Otherwise use dynamic threshold based on movement
        const velocityScale = Math.min(Math.pow(this.currentHmdVelocity / 1.0, 2), 1);
        const rotationFactor = Math.pow(this.currentHmdRotationVelocity / (Math.PI/4), 2);
        
        // Calculate thresholds
        const rotationThreshold = rotationFactor * (this.maxThreshold - this.baseThreshold) + this.baseThreshold;
        const movementThreshold = this.baseThreshold + (this.maxThreshold - this.baseThreshold) * velocityScale;
        
        // Take the maximum of both thresholds
        const threshold = Math.max(movementThreshold, rotationThreshold);
        
        if (this.shouldLog()) {
            CustomLogger.log("origin", `Threshold calculation:`);
            CustomLogger.log("origin", `- Moving Significantly: ${isMovingSignificantly}`);
            CustomLogger.log("origin", `- Exceeded Deadzone: ${this.hasExceededDeadzone}`);
            CustomLogger.log("origin", `- Head Velocity: ${this.currentHmdVelocity.toFixed(6)} m/s`);
            CustomLogger.log("origin", `- Head Rotation: ${(this.currentHmdRotationVelocity * 180 / Math.PI).toFixed(2)}°/s`);
            CustomLogger.log("origin", `- Movement Threshold: ${movementThreshold.toFixed(6)}`);
            CustomLogger.log("origin", `- Rotation Threshold: ${rotationThreshold.toFixed(6)}`);
            CustomLogger.log("origin", `- Final Threshold: ${threshold.toFixed(6)}`);
        }
        
        return threshold;
    }

    private isSignificantChange(
        vrChatTransform: OpenVR.HmdMatrix34,
        hmdTransform: OpenVR.HmdMatrix34,
        combinedTransform: OpenVR.HmdMatrix34
    ): boolean {
        // Update HMD velocities first
        this.updateHmdVelocities(hmdTransform);

        if (!this.lastStableTransform) {
            const pos = this.extractPosition(combinedTransform);
            this.stablePosition = pos;
            return true;
        }

        // Get current position
        const currentPos = this.extractPosition(combinedTransform);
        const currentRot = this.extractRotation(combinedTransform);
        const lastStableRot = this.extractRotation(this.lastStableTransform);

        // Calculate distance from stable position
        const distanceFromStable = this.calculateDistance(currentPos, this.stablePosition!);
        const rotationDelta = this.calculateRotationDelta(currentRot, lastStableRot);

        // Get current threshold based on HMD velocities
        const currentThreshold = this.getCurrentThreshold();

        // Check if movement is small enough to reset deadzone
        const isVeryStable = 
            this.currentHmdVelocity <= this.resetDeadzoneVelocityThreshold &&
            this.currentHmdRotationVelocity <= this.resetDeadzoneRotationThreshold;
            
        if (isVeryStable) {
            this.hasExceededDeadzone = false;
        }
        // Otherwise check if we've exceeded deadzone
        else if (distanceFromStable > this.deadzoneThreshold) {
            this.hasExceededDeadzone = true;
        }
        
        // Reset deadzone flag when moving significantly
        const isMovingSignificantly = 
            this.currentHmdVelocity > this.significantMovementThreshold ||
            this.currentHmdRotationVelocity > this.significantRotationThreshold;
            
        if (isMovingSignificantly) {
            this.hasExceededDeadzone = false;
        }

        // Check if we've moved significantly from our stable position
        const hasSignificantMovement = 
            distanceFromStable > currentThreshold ||
            rotationDelta > this.rotationThreshold;

        const assumedStationary = !hasSignificantMovement;
        
        if (this.shouldLogAssumed()) {
            CustomLogger.log("origin", `Assumed not moving in VRChat: ${assumedStationary}`);
            if (assumedStationary) {
                CustomLogger.log("origin", `Distance from stable: ${distanceFromStable.toFixed(6)} (threshold: ${currentThreshold.toFixed(6)})`);
                CustomLogger.log("origin", `HMD Velocity: ${this.currentHmdVelocity.toFixed(2)} m/s`);
                CustomLogger.log("origin", `HMD Rotation Velocity: ${(this.currentHmdRotationVelocity * 180 / Math.PI).toFixed(2)} deg/s`);
                CustomLogger.log("origin", `Moving Significantly: ${isMovingSignificantly}`);
                CustomLogger.log("origin", `Very Stable: ${isVeryStable}`);
                CustomLogger.log("origin", `Exceeded Deadzone: ${this.hasExceededDeadzone}`);
            }
        }

        // If movement is below thresholds, don't update
        if (assumedStationary) {
            if (this.shouldLog()) {
                CustomLogger.log("origin", `Movement details (below threshold):`);
                CustomLogger.log("origin", `- Current Position: (${currentPos.x.toFixed(6)}, ${currentPos.y.toFixed(6)}, ${currentPos.z.toFixed(6)})`);
                CustomLogger.log("origin", `- Stable Position: (${this.stablePosition!.x.toFixed(6)}, ${this.stablePosition!.y.toFixed(6)}, ${this.stablePosition!.z.toFixed(6)})`);
                CustomLogger.log("origin", `- Distance: ${distanceFromStable.toFixed(6)}`);
                CustomLogger.log("origin", `- Current Threshold: ${currentThreshold.toFixed(6)}`);
                CustomLogger.log("origin", `- HMD Velocity: ${this.currentHmdVelocity.toFixed(2)} m/s`);
                CustomLogger.log("origin", `- HMD Rotation Velocity: ${(this.currentHmdRotationVelocity * 180 / Math.PI).toFixed(2)} deg/s`);
                CustomLogger.log("origin", `- Rotation Delta: ${rotationDelta.toFixed(6)}`);
            }
            return false;
        }

        // If we've moved significantly, update our stable position
        this.stablePosition = currentPos;

        if (this.shouldLog()) {
            CustomLogger.log("origin", `Movement details (above threshold):`);
            CustomLogger.log("origin", `- Distance from stable: ${distanceFromStable.toFixed(6)}`);
            CustomLogger.log("origin", `- Current Threshold: ${currentThreshold.toFixed(6)}`);
            CustomLogger.log("origin", `- HMD Velocity: ${this.currentHmdVelocity.toFixed(2)} m/s`);
            CustomLogger.log("origin", `- HMD Rotation Velocity: ${(this.currentHmdRotationVelocity * 180 / Math.PI).toFixed(2)} deg/s`);
            CustomLogger.log("origin", `- Rotation delta: ${rotationDelta.toFixed(6)}`);
            CustomLogger.log("origin", `- Updating stable position to: (${currentPos.x.toFixed(6)}, ${currentPos.y.toFixed(6)}, ${currentPos.z.toFixed(6)})`);
        }

        return true;
    }

    getStabilizedTransform(
        vrChatTransform: OpenVR.HmdMatrix34,
        hmdTransform: OpenVR.HmdMatrix34,
        combinedTransform: OpenVR.HmdMatrix34
    ): OpenVR.HmdMatrix34 {
        if (this.isSignificantChange(vrChatTransform, hmdTransform, combinedTransform)) {
            this.lastStableTransform = combinedTransform;
            return combinedTransform;
        }
        return this.lastStableTransform || combinedTransform;
    }
}
