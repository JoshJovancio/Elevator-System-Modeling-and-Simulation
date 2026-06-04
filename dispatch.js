function allowedOperationalFloors(serveFloor2) {
    const floors = [];
    for (let floor = 0; floor < FLOOR_COUNT; floor++) {
        if (!serveFloor2 && floor === FLOOR_2_INDEX) continue;
        floors.push(floor);
    }
    return floors;
}

function dynamicServiceFloors(elevatorId) {
    const zones = {
        1: [0, 1, 2, 3, 4],       // Lower Floors: Base to Hub (Physical Floors 1-5)
        2: [0, 4, 5, 6, 7],       // Mid Floors: Hub Focused (Physical Floors 1, 5-8)
        3: [0, 4, 7, 8, 9, 10],   // Upper Floors: Hub to Penthouse (Physical Floors 1, 5, 8-11)
        4: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10], // Express Loop: All Floors
    };
    return zones[elevatorId] || [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
}

function routeImmediateDestination(origin, finalDestination, strategy) {
    if (strategy !== "Split zone") return finalDestination;
    if (runtimeConfig.serveFloor2 && (origin === FLOOR_2_INDEX || finalDestination === FLOOR_2_INDEX)) {
        return finalDestination;
    }

    const blueDirect = BLUE_FLOORS.includes(origin) && BLUE_FLOORS.includes(finalDestination);
    const redDirect = RED_FLOORS.includes(origin) && RED_FLOORS.includes(finalDestination);

    if (blueDirect || redDirect) return finalDestination;
    
    // If bridging zones, route explicitly through the shared hub
    return HUB_FLOOR;
}

function passengerDestination(origin, phase, validFloors) {
    const classroomFloors = validFloors.filter((floor) => floor >= 3);
    const upperClassrooms = validFloors.filter((floor) => floor >= 7);
    const lowerClassrooms = validFloors.filter((floor) => floor >= 3 && floor <= 6);

    if (phase.kind === "course_start") {
        return weightedChoice([
            [random(classroomFloors), 0.55],
            [random(upperClassrooms), 0.25],
            [random(lowerClassrooms), 0.20],
        ], origin, validFloors);
    }
    if (phase.kind === "outflow") {
        return weightedChoice([
            [0, 0.82],
            [4, 0.08],
            [random(classroomFloors), 0.10],
        ], origin, validFloors);
    }
    if (phase.kind === "lunch") {
        return weightedChoice([
            [0, 0.48],
            [4, 0.16],
            [random(classroomFloors), 0.36],
        ], origin, validFloors);
    }
    return weightedChoice([
        [0, 0.30],
        [4, 0.16],
        [random(classroomFloors), 0.54],
    ], origin, validFloors);
}

function passengerOrigin(phase, validFloors) {
    const classroomFloors = validFloors.filter((floor) => floor >= 3);

    if (phase.kind === "course_start") {
        return random(1) < 0.88 ? 0 : random(classroomFloors);
    }
    if (phase.kind === "outflow") {
        return random(1) < 0.90 ? random(classroomFloors) : 0;
    }
    if (phase.kind === "lunch") {
        if (random(1) < 0.60) return random(classroomFloors);
        return random([0, 4]);
    }
    return random(1) < 0.55 ? random(classroomFloors) : random(validFloors);
}

function weightedChoice(weightedItems, origin, fallbackFloors) {
    let roll = random(1);
    let total = 0;

    for (const [value, weight] of weightedItems) {
        total += weight;
        if (roll <= total && value !== undefined && value !== origin) return value;
    }

    let fallback = random(fallbackFloors);
    while (fallback === origin) fallback = random(fallbackFloors);
    return fallback;
}

function chooseBestElevator(floorIdx, destinationIdx, elevators, floorQueues, strategy) {
    const candidates = elevators.filter((elevator) => {
        return elevator.canServe(floorIdx, strategy) && elevator.canServe(destinationIdx, strategy);
    });

    const usable = candidates.length > 0 ? candidates : elevators;
    const desiredDirection = Math.sign(destinationIdx - floorIdx);

    usable.sort((a, b) => {
        return elevatorScore(a, floorIdx, desiredDirection, floorQueues, strategy) -
            elevatorScore(b, floorIdx, desiredDirection, floorQueues, strategy);
    });

    return usable[0];
}

/**
 * Calculates a physics-based ETA score evaluating travel time, stops, and load penalties.
 */
function elevatorScore(elevator, floorIdx, desiredDirection, floorQueues, strategy) {
    if (!elevator.canServe(floorIdx, strategy)) return 10000; // Strict structural rejection
    if (elevator.cabin.length >= elevator.capacity) return 5000;  // Capacity saturation bypass

    const currentFloor = elevator.currentFloor;
    const distance = Math.abs(currentFloor - floorIdx);
    
    // Core physical movement cost
    let score = distance * elevator.travelSecondsPerFloor;

    // Directional Consensus Evaluation
    if (elevator.direction !== 0) {
        const platformDirection = Math.sign(floorIdx - currentFloor);
        
        // If elevator is moving away from the call or heading in the opposite direction
        if (platformDirection !== elevator.direction || desiredDirection !== elevator.direction) {
            score += 45.0; // Significant penalty for breaking directional alignment
        }
    }

    // Dynamic Stop Overhead Estimator
    // Account for time required to cycle doors and handle current intermediate occupants
    const intermediateStops = elevator.cabin.filter(p => {
        if (elevator.direction > 0) return p.immediateDestination > currentFloor && p.immediateDestination < floorIdx;
        if (elevator.direction < -1) return p.immediateDestination < currentFloor && p.immediateDestination > floorIdx;
        return false;
    }).length;

    score += intermediateStops * (elevator.doorSeconds + 2.0);
    
    // Congestion Backpressure handling
    score += elevator.cabin.length * 1.5;

    return score;
}

function selectNextTarget(elevator, floorQueues, strategy) {
    const current = elevator.integerFloor();
    
    // Priority 1: Deliver passengers currently inside the cabin
    if (elevator.cabin.length > 0) {
        const onboardTargets = elevator.cabin.map((p) => p.immediateDestination);
        return nearestFloor(current, onboardTargets);
    }

    // Priority 2: Scan for waiting passengers assigned to this specific car
    const callableFloors = [];
    for (let floor = 0; floor < floorQueues.length; floor++) {
        if (!elevator.canServe(floor, strategy)) continue;

        const hasAssignedPassenger = floorQueues[floor].waiting.some((p) => {
            return p.assignedElevatorId === elevator.id && elevator.canServe(p.immediateDestination, strategy);
        });

        if (hasAssignedPassenger) {
            callableFloors.push(floor);
        }
    }

    // Default: If no tasks exist, return to the designated home terminal floor
    if (callableFloors.length === 0) {
        const homeFloor = (strategy === "Split zone" && elevator.zone === "RED") ? HUB_FLOOR : 0;
        if (current !== homeFloor && elevator.canServe(homeFloor, strategy)) {
            return homeFloor;
        }
        return null;
    }

    // Dynamic Zoning Strategy Selection Engine
    if (strategy === "Dynamic zoning") {
        callableFloors.sort((a, b) => {
            const queueB = floorQueues[b].count();
            const queueA = floorQueues[a].count();
            
            // Primary sort by real-time queue pressure density
            if (queueB !== queueA) return queueB - queueA;
            // Secondary sort by physical proximity to minimize system delay
            return Math.abs(a - current) - Math.abs(b - current);
        });
        return callableFloors[0];
    }

    return nearestFloor(current, callableFloors);
}

function nearestFloor(currentFloor, floors) {
    return [...new Set(floors)].sort((a, b) => Math.abs(a - currentFloor) - Math.abs(b - currentFloor))[0];
}