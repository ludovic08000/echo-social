export class MLSSession {
  constructor(groupId){
    this.groupId = groupId;
    this.epoch = 0;
    this.members = [];
  }

  addMember(member){
    this.members.push(member);
    this.epoch++;
  }

  removeMember(member){
    this.members = this.members.filter(m=>m!==member);
    this.epoch++;
  }

  deriveGroupKey(){
    return `${this.groupId}-${this.epoch}`;
  }
}
